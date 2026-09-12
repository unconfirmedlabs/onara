import type { Signer as SdkSigner } from '@mysten/sui/cryptography'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions'
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  Config,
  Context,
  Effect,
  Layer,
  Schema,
} from 'effect'
import {
  BuildError,
  DecodeError,
  Digest,
  ExecutionFailed,
  Executed,
  NetworkMismatch,
  SigningError,
  Sui,
  SuiCore,
  SuiAddress,
  TransportError,
} from '@unconfirmed/sui-effect'
import { SuiExtension, type ExtensionFace, type PromiseFace } from '@unconfirmed/sui-effect/extension'
import {
  Journal,
  Signer,
  Signed,
  Tx,
  type Signer as EffectSigner,
  type SubmitViaError,
} from '@unconfirmed/sui-effect/tx'
import {
  OnaraError,
  OnaraValidationOnly,
} from './errors'
import type {
  OnaraErrorResponse,
  OnaraRequestError,
  OnaraService,
  OnaraTransactionError,
  SponsorDryRunResponse,
  SponsorOptions,
  SponsorResponse,
  SponsorTransactionOptions,
  StatusResponse,
  TransactionStatusResponse,
} from './types'

/** Options for the live Onara service layer. */
export interface OnaraLayerOptions {
  readonly url: string
  /** Custom `fetch` implementation, such as a Worker service binding. */
  readonly fetch?: typeof fetch
  /** Submission journal; defaults to a fresh in-memory journal for this layer. */
  readonly journal?: import('@unconfirmed/sui-effect/tx').JournalService
}

/** Options accepted by the `$extend` registration factory. */
export interface OnaraExtensionOptions<Name extends string = 'onara'>
  extends OnaraLayerOptions {
  /** Property name the client is registered under. Defaults to `onara`. */
  readonly name?: Name
  /** Optional chain pin for custom networks. */
  readonly sui?: import('@unconfirmed/sui-effect').SuiLayerOptions
}

const Outcome = Schema.Literals(['not_applied', 'unknown', 'applied'])

const statusWire = Schema.Struct({
  network: Schema.String,
  // Sui's chain identifier is the base58 genesis checkpoint digest.
  chainId: Digest,
  address: SuiAddress,
  balances: Schema.Struct({
    active: Schema.String,
    pending: Schema.String,
  }),
  policyDigest: Schema.String,
  policyVersion: Schema.Number,
  engineVersion: Schema.String,
})

const dryRunWire = Schema.Struct({
  dryRun: Schema.Literal(true),
  policy: Schema.String,
  moveCallTargets: Schema.Array(Schema.String),
})

const errorWire = Schema.Struct({
  error: Schema.String,
  digest: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(['unconfirmed', 'unknown'])),
  txStatus: Schema.optional(Schema.Literals(['unconfirmed', 'unknown'])),
  outcome: Schema.optional(Outcome),
  /** Structured applied failure returned by the API. */
  failure: Schema.optional(Schema.Unknown),
})

const decodeError = (
  issue: { readonly message: string },
  kind: 'shape' | 'bytes' = 'shape',
): DecodeError =>
  new DecodeError({
    kind,
    issue: issue.message,
  })

const decode = <SchemaType extends Schema.Top>(
  schema: SchemaType,
  input: unknown,
): Effect.Effect<SchemaType['Type'], DecodeError, SchemaType['DecodingServices']> =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((issue) => decodeError(issue)),
  )

const normalizeBaseUrl = (raw: string): string => {
  const parsed = new URL(raw)
  return parsed.toString().replace(/\/+$/, '')
}

type HttpDefaultOutcome = 'not_applied' | 'unknown'

/**
 * Adapt the API's compact applied-failure envelope to the upstream reply
 * shape understood by `Tx.submitVia`. This keeps the failure terminal: the
 * relay has already supplied on-chain evidence, so submitVia must journal it
 * as applied rather than reconcile a transaction that is known to have run.
 */
type FailedTransactionReply = {
  readonly $kind: 'FailedTransaction'
  readonly FailedTransaction: Record<string, unknown>
}

function failedTransactionReply(failure: ExecutionFailed): FailedTransactionReply {
  const encoded = Schema.encodeUnknownSync(ExecutionFailed)(failure) as {
    readonly digest: string
    readonly reason: Record<string, unknown>
    readonly command?: number
    readonly effects: unknown
  }
  return {
    $kind: 'FailedTransaction',
    FailedTransaction: {
      digest: encoded.digest,
      effects: encoded.effects,
      events: [],
      balanceChanges: [],
      objectTypes: {},
      checkpoint: null,
      timestampMs: null,
      status: {
        success: false,
        error: {
          ...encoded.reason,
          message: failure.message,
          ...(encoded.command === undefined ? {} : { command: encoded.command }),
        },
      },
    },
  }
}

/** A tagged Effect service over Onara's HTTP boundary. */
export class Onara extends Context.Service<Onara, OnaraService>()(
  '@unconfirmed/onara/Onara',
) {
  /**
   * Build the service over the `Sui` layer supplied by the consumer's client.
   * Fails with `DecodeError` for an invalid URL and with request/lifecycle
   * errors from the service members.
   */
  static readonly layer = (
    options: OnaraLayerOptions,
  ): Layer.Layer<Onara, DecodeError, Sui> =>
    Layer.effect(
      Onara,
      Effect.gen(function* () {
        const sui = yield* Sui
        const baseUrl = yield* Effect.try({
          try: () => normalizeBaseUrl(options.url),
          catch: (cause) =>
            new DecodeError({
              kind: 'shape',
              issue: `Invalid Onara URL: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        })
        const fetchImpl = options.fetch ?? globalThis.fetch
        const journal = options.journal ?? Journal.makeMemoryUnsafe()

        const request = Effect.fn('Onara.request')(function* (
          method: string,
          path: string,
          init?: RequestInit,
        ) {
          return yield* Effect.tryPromise({
            try: (signal) =>
              fetchImpl(`${baseUrl}${path}`, {
                ...init,
                signal,
              }),
            catch: (cause) => TransportError.fromUnknown(method, cause),
          })
        })

        const responseBody = Effect.fn('Onara.responseBody')(function* (
          method: string,
          response: Response,
        ) {
          return yield* Effect.tryPromise({
            try: () => response.json() as Promise<unknown>,
            catch: (cause) =>
              new DecodeError({
                kind: 'shape',
                issue: `${method} returned invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
        })

        const makeHttpError = (
          response: Response,
          parsed: OnaraErrorResponse,
          defaultOutcome: HttpDefaultOutcome,
        ): OnaraError => new OnaraError({
          message: parsed.error,
          status: response.status,
          ...(parsed.digest === undefined ? {} : { digest: parsed.digest }),
          ...(parsed.txStatus === undefined && parsed.status === undefined
            ? {}
            : { txStatus: parsed.txStatus ?? parsed.status }),
          outcome: parsed.outcome ?? (
            response.status >= 500 ? defaultOutcome : 'not_applied'
          ),
        })

        const httpError = Effect.fn('Onara.httpError')(function* (
          method: string,
          response: Response,
          body: unknown,
          defaultOutcome: HttpDefaultOutcome,
        ) {
          const parsed = yield* decode(errorWire, body)
          return yield* Effect.fail(makeHttpError(response, parsed, defaultOutcome))
        })

        const sponsorHttpError = Effect.fn('Onara.sponsorHttpError')(function* (
          method: string,
          response: Response,
          body: unknown,
        ): Effect.fn.Return<never, OnaraRequestError | ExecutionFailed> {
          const parsed = yield* decode(errorWire, body)
          if (parsed.outcome === 'applied' && parsed.failure !== undefined) {
            const failure = yield* Schema.decodeUnknownEffect(ExecutionFailed)(parsed.failure).pipe(
              Effect.mapError((issue) => decodeError(issue)),
            )
            return yield* Effect.fail(failure)
          }
          return yield* Effect.fail(makeHttpError(response, parsed, 'unknown'))
        })

        const decodeStatus = (body: unknown) =>
          decode(statusWire, body).pipe(
            Effect.map((value): StatusResponse => value),
          )

        const status: OnaraService['status'] = Effect.gen(function* () {
            const response = yield* request('Onara.status', '/status')
            const body = yield* responseBody('Onara.status', response)
            if (!response.ok) return yield* httpError('Onara.status', response, body, 'not_applied')
            return yield* decodeStatus(body)
          }).pipe(Effect.withSpan('Onara.status'))

        const decodeDryRun = (body: unknown) =>
          decode(dryRunWire, body).pipe(
            Effect.map((value): SponsorDryRunResponse => value),
          )

        const decodeExecution = (body: unknown) =>
          Executed.fromPartial(body)

        const parseQuery = (options: {
          readonly dryRun?: boolean
          readonly waitForExecution?: boolean
        }): string => {
          const params = new URLSearchParams()
          if (options.dryRun) params.set('dryRun', 'true')
          if (options.waitForExecution === false) {
            params.set('waitForExecution', 'false')
          }
          const query = params.toString()
          return query.length === 0 ? '' : `?${query}`
        }

        const payloadBody = (
          sender: string,
          txBytes: string,
          txSignature: string,
        ) =>
          JSON.stringify({
            sender,
            txBytes,
            txSignature,
          })

        const requestSponsor: (
          options: SponsorOptions,
        ) => Effect.Effect<SponsorResponse, OnaraRequestError | ExecutionFailed> = Effect.fn('Onara.requestSponsor')(function* (
          options: SponsorOptions,
        ) {
          const response = yield* request(
            'Onara.sponsor',
            `/sponsor${parseQuery(options)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payloadBody(
                options.sender,
                options.txBytes,
                options.txSignature,
              ),
            },
          )
          const body = yield* responseBody('Onara.sponsor', response)
          if (!response.ok) return yield* sponsorHttpError('Onara.sponsor', response, body)
          if (
            body !== null &&
            typeof body === 'object' &&
            'dryRun' in body &&
            body.dryRun === true
          ) {
            return yield* decodeDryRun(body)
          }
          return yield* decodeExecution(body)
        })

        const requestDryRun: (
          options: SponsorOptions,
        ) => Effect.Effect<SponsorDryRunResponse, OnaraRequestError> = Effect.fn('Onara.requestDryRun')(function* (
          options: SponsorOptions,
        ) {
          const response = yield* request(
            'Onara.sponsor.dryRun',
            `/sponsor${parseQuery({ ...options, dryRun: true })}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: payloadBody(
                options.sender,
                options.txBytes,
                options.txSignature,
              ),
            },
          )
          const body = yield* responseBody('Onara.sponsor.dryRun', response)
          if (!response.ok) return yield* httpError('Onara.sponsor.dryRun', response, body, 'not_applied')
          return yield* decodeDryRun(body)
        })

        const sendSigned = (
          signed: import('@unconfirmed/sui-effect/tx').Signed,
          options: Pick<SponsorOptions, 'waitForExecution'>,
        ): Effect.Effect<SponsorResponse, OnaraRequestError | SubmitViaError, never> =>
          Tx.submitVia(signed, (bytes, signatures) => {
              const senderSignature = signatures[0]
              if (senderSignature === undefined) {
                return Effect.fail(
                  new OnaraError({
                    message: 'A sender signature is required.',
                    status: 400,
                    outcome: 'not_applied',
                  }),
                )
              }
              return requestSponsor({
                sender: signed.sender,
                txBytes: toBase64(bytes),
                txSignature: senderSignature,
                waitForExecution: options.waitForExecution,
              }).pipe(
                Effect.catchTag('ExecutionFailed', (failure) =>
                  failure.digest === signed.digest
                    ?
                      // submitVia understands the upstream FailedTransaction
                      // envelope and journals the applied failure terminally.
                      // The API's compact failure object is adapted here at
                      // the wire boundary so it cannot be mistaken for an
                      // ambiguous send.
                      Effect.succeed<SponsorResponse | FailedTransactionReply>(failedTransactionReply(failure))
                    : Effect.fail(failure),
                ),
                Effect.flatMap((response) => {
                  if ('dryRun' in response && response.dryRun === true) {
                    return Effect.fail(
                      new OnaraValidationOnly({
                        policy: response.policy,
                        moveCallTargets: [...response.moveCallTargets],
                        outcome: 'not_applied',
                      }),
                    )
                  }
                  return Effect.succeed(response)
                }),
              )
            }).pipe(
            Effect.provideService(Sui, sui),
            Effect.provideService(Journal, journal),
            Effect.catchTag('OnaraValidationOnly', (error) =>
              Effect.succeed({
                dryRun: true as const,
                policy: error.policy,
                moveCallTargets: error.moveCallTargets,
              }),
            ),
          )

        const parseSigned = Effect.fn('Onara.parseSigned')(function* (
          options: SponsorOptions,
          chainId: string,
        ) {
          const bytes = yield* Effect.try({
            try: () => fromBase64(options.txBytes),
            catch: (cause) =>
              new DecodeError({
                kind: 'bytes',
                issue: `The transaction bytes are not valid base64: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
          const data = yield* Effect.try({
            try: () => TransactionDataBuilder.fromBytes(bytes),
            catch: (cause) =>
              new DecodeError({
                kind: 'bytes',
                issue: `The transaction bytes could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
          const byteSender = yield* Effect.try({
            try: () => {
              if (data.sender === null) {
                throw new Error('The transaction has no sender.')
              }
              return normalizeSuiAddress(data.sender)
            },
            catch: (cause) =>
              new DecodeError({
                kind: 'shape',
                issue: `The transaction sender is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
          const requestedSender = yield* Effect.try({
            try: () => normalizeSuiAddress(options.sender),
            catch: (cause) =>
              new DecodeError({
                kind: 'shape',
                issue: `The requested sender is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
          if (byteSender !== requestedSender) {
            return yield* Effect.fail(
              new OnaraError({
                message: 'Transaction sender does not match payload sender.',
                status: 400,
                outcome: 'not_applied',
              }),
            )
          }
          const digest = yield* Effect.try({
            try: () => TransactionDataBuilder.getDigestFromBytes(bytes),
            catch: (cause) =>
              new DecodeError({
                kind: 'bytes',
                issue: `The transaction digest could not be computed: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          })
          const expirationChain =
            data.expiration?.$kind === 'ValidDuring'
              ? data.expiration.ValidDuring.chain
              : data.expiration?.$kind === 'Validity'
                ? data.expiration.Validity.chain
                : undefined
          if (expirationChain !== undefined && expirationChain !== chainId) {
            return yield* Effect.fail(
              new NetworkMismatch({ expected: chainId, actual: expirationChain }),
            )
          }
          const expiration = data.expiration ?? undefined
          return yield* Schema.decodeUnknownEffect(Signed)({
            digest,
            // SignedTransaction is an encoded schema: bytes are base64 here,
            // while the runtime transaction remains the exact original bytes.
            bytes: options.txBytes,
            signatures: [options.txSignature],
            sender: byteSender,
            ...(expiration === undefined ? {} : { expiration }),
            chain: chainId,
          }).pipe(
            Effect.mapError((issue) => decodeError(issue, 'shape')),
          )
        })

        const sponsor: OnaraService['sponsor'] = Effect.fn('Onara.sponsor')(
          function* (options) {
            const info = yield* status
            if (info.chainId !== sui.chainId) {
              return yield* Effect.fail(
                new NetworkMismatch({
                  expected: sui.chainId,
                  actual: info.chainId,
                }),
              )
            }
            const signed = yield* parseSigned(options, info.chainId)
            if (options.dryRun === true) {
              return yield* requestDryRun(options)
            }
            return yield* sendSigned(signed, options)
          },
        )

        const asEffectSigner = (
          signer: EffectSigner | SdkSigner,
        ): Effect.Effect<EffectSigner, import('@unconfirmed/sui-effect').SigningError> =>
          Effect.try({
            try: () =>
              'address' in signer && 'signTransaction' in signer
                ? (signer as EffectSigner)
                : Signer.fromSdkSigner(signer as SdkSigner),
            catch: (cause) =>
              new SigningError({ cause }),
          })

        const sponsorTransaction: OnaraService['sponsorTransaction'] = Effect.fn(
          'Onara.sponsorTransaction',
        )(function* (options) {
          const info = yield* status
          if (info.chainId !== sui.chainId) {
            return yield* Effect.fail(
              new NetworkMismatch({
                expected: sui.chainId,
                actual: info.chainId,
              }),
            )
          }
          const signer = yield* asEffectSigner(options.signer)
          const sender = signer.address
          const gasOwner = SuiAddress.normalize(info.address)

          const input = yield* Effect.try({
            try: () => {
              if (typeof options.transaction === 'function') {
                return Tx.sponsored({ sender, gasOwner })(options.transaction)
              }
              const transaction = Transaction.from(options.transaction)
              transaction.setSender(sender)
              transaction.setGasOwner(gasOwner)
              transaction.setGasPayment([])
              return transaction
            },
            catch: (cause) =>
              new BuildError({
                message: 'The transaction could not be prepared for sponsorship.',
                cause,
              }),
          })

          const build = Tx.build(input, { sender, gasOwner })
          const built = yield* (options.client === undefined
            ? build.pipe(Effect.provideService(Sui, sui))
            : Effect.provide(
                build,
                Sui.layerNoDepsWith({ chainId: sui.chainId }).pipe(
                  Layer.provide(SuiCore.layerFromClient(options.client)),
                ),
              ))
          const signed = yield* Tx.sign(built, signer)
          if (options.dryRun === true) {
            return yield* requestDryRun({
              sender,
              txBytes: toBase64(signed.bytes),
              txSignature: signed.signatures[0]!,
              dryRun: true,
              waitForExecution: options.waitForExecution,
            })
          }
          return yield* sendSigned(signed, {
            waitForExecution: options.waitForExecution,
          })
        })

        const getTransactionStatus: OnaraService['getTransactionStatus'] = Effect.fn(
          'Onara.getTransactionStatus',
        )(function* (digestInput) {
          const digest = yield* decode(Digest, digestInput)
          const response = yield* request(
            'Onara.getTransactionStatus',
            `/sponsor/${encodeURIComponent(digest)}/status`,
          )
          const body = yield* responseBody('Onara.getTransactionStatus', response)
          if (response.status === 404) {
            if (
              body !== null &&
              typeof body === 'object' &&
              'found' in body &&
              body.found === false
            ) {
              return { found: false as const, digest }
            }
            return yield* decodeError({
              message: 'A 404 status response did not prove the transaction was absent.',
            })
          }
          if (!response.ok) {
            return yield* httpError('Onara.getTransactionStatus', response, body, 'not_applied')
          }
          if (
            body === null ||
            typeof body !== 'object' ||
            !('found' in body) ||
            body.found !== true
          ) {
            return yield* decodeError({
              message: 'The transaction status response did not contain found:true.',
            })
          }
          const envelope = { ...(body as Record<string, unknown>) }
          delete envelope.found
          if ('failure' in envelope) {
            const failure = yield* Schema.decodeUnknownEffect(ExecutionFailed)(envelope.failure).pipe(
              Effect.mapError((issue) => decodeError(issue)),
            )
            if (failure.digest !== digest) {
              return yield* decodeError({
                message: 'The failed transaction status digest did not match the requested digest.',
              })
            }
            return { found: true as const, digest, failure }
          }
          const result = yield* decodeExecution(envelope)
          if (result.digest !== digest) {
            return yield* decodeError({
              message: 'The transaction status digest did not match the requested digest.',
            })
          }
          return { found: true as const, digest: result.digest, result }
        })

        return { status, sponsor, sponsorTransaction, getTransactionStatus }
      }),
    )

  /** Reads `ONARA_URL` through Effect Config and validates it as a URL. */
  static readonly layerConfig: Layer.Layer<
    Onara,
    Config.ConfigError | DecodeError,
    Sui
  > = Layer.unwrap(
    Effect.map(
      Config.url('URL').pipe(Config.nested('ONARA')),
      (url) => Onara.layer({ url: url.href }),
    ),
  )

  /** Production service over a supplied fetch, intended for integration tests. */
  static readonly layerTest = (
    options: OnaraLayerOptions,
  ): Layer.Layer<Onara, DecodeError, Sui> => Onara.layer(options)
}

/**
 * The legacy name is retained as a type alias for the derived Promise face.
 * There is intentionally no URL-only constructor: every usable client must
 * share the consumer's Sui runtime through `$extend`.
 */
export type OnaraClient = PromiseFace<OnaraService> & ExtensionFace

/**
 * Register Onara as a native Sui client extension. The returned face is
 * derived from `OnaraService`; Effect callers can provide `Onara.layer`
 * directly instead.
 */
export function onara<const Name extends string = 'onara'>(
  options: OnaraExtensionOptions<Name>,
) {
  const { name = 'onara' as Name, sui, ...layerOptions } = options
  return SuiExtension.fromService(Onara, {
    name,
    layer: Onara.layer(layerOptions),
    ...(sui === undefined ? {} : { sui }),
  })
}
