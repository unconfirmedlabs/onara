import { TransactionDataBuilder } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  Executed,
  JournalError,
  NetworkMismatch,
  NotApplied,
  SigningError,
  SubmissionUnknown,
  Sui,
  TransportError,
} from '@unconfirmed/sui-effect'
import {
  Duration,
  Effect,
  ManagedRuntime,
  Schedule,
  Schema,
} from 'effect'
import {
  Journal,
  Signed,
  SubmitConfig,
  Tx,
  type JournalService,
  type Signer,
  type Signed as SignedTransaction,
} from '@unconfirmed/sui-effect/tx'

/** The decoded result of the API's sponsored submission boundary. */
export type ExecutionOutcome =
  | { readonly kind: 'success'; readonly result: import('@unconfirmed/sui-effect').Executed; readonly durationMs: number }
  | { readonly kind: 'chain_failed'; readonly result: ExecutionFailed; readonly durationMs: number }
  | { readonly kind: 'submission_unknown'; readonly error: SubmissionUnknown; readonly durationMs: number }
  | { readonly kind: 'not_applied'; readonly error: ExecutionError; readonly durationMs: number }
  | { readonly kind: 'execution_timeout'; readonly digest?: string; readonly durationMs: number; readonly error: string }
  | { readonly kind: 'execution_error'; readonly digest?: string; readonly durationMs: number; readonly error: string }

/** Errors that prove the server never submitted bytes. */
export type ExecutionError =
  | BuildError
  | DecodeError
  | NetworkMismatch
  | NotApplied
  | SigningError
  | TransportError
  | import('@unconfirmed/sui-effect').JournalError

export interface ExecutionParams {
  /** The one reusable runtime owned by the API worker/process. */
  readonly effectRuntime: ManagedRuntime.ManagedRuntime< Sui, never>
  /** The sponsor signer value, constructed once with the API runtime. */
  readonly sponsorSigner: Signer
  readonly chainId: string
  readonly sender: string
  readonly txBytes: Uint8Array
  readonly txSignature: string
  readonly waitForExecution: boolean
  readonly executionTimeoutMs: number
  readonly confirmationTimeoutMs: number
}

function decodeError(issue: { readonly message: string }, kind: 'shape' | 'bytes'): DecodeError {
  return new DecodeError({ kind, issue: issue.message })
}

/**
 * Converts an already sender-signed BCS payload into the domain's `Signed`
 * value. This only parses metadata; it never calls `Tx.build`, so the bytes
 * and the sender signature remain exactly the values supplied by the client.
 */
function signedFromBytes(params: {
  readonly chainId: string
  readonly sender: string
  readonly txBytes: Uint8Array
  readonly txSignature: string
}): Effect.Effect<SignedTransaction, DecodeError | NetworkMismatch> {
  return Effect.gen(function* () {
    const data = yield* Effect.try({
      try: () => TransactionDataBuilder.fromBytes(params.txBytes),
      catch: (cause) => decodeError({
        message: `The sender-signed transaction bytes could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
      }, 'bytes'),
    })
    if (data.sender === null) {
      return yield* Effect.fail(
        decodeError({ message: 'The sender-signed transaction has no sender.' }, 'shape'),
      )
    }
    const sender = yield* Effect.try({
      try: () => normalizeSuiAddress(data.sender!),
      catch: (cause) => decodeError({
        message: `The transaction sender is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      }, 'shape'),
    })
    const requestedSender = yield* Effect.try({
      try: () => normalizeSuiAddress(params.sender),
      catch: (cause) => decodeError({
        message: `The requested sender is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
      }, 'shape'),
    })
    if (sender !== requestedSender) {
      return yield* Effect.fail(
        decodeError({ message: 'Transaction sender does not match payload sender.' }, 'shape'),
      )
    }

    const expirationChain =
      data.expiration?.$kind === 'ValidDuring'
        ? data.expiration.ValidDuring.chain
        : data.expiration?.$kind === 'Validity'
          ? data.expiration.Validity.chain
          : undefined
    if (expirationChain !== undefined && expirationChain !== params.chainId) {
      return yield* Effect.fail(
        new NetworkMismatch({ expected: params.chainId, actual: expirationChain }),
      )
    }

    const digest = yield* Effect.try({
      try: () => TransactionDataBuilder.getDigestFromBytes(params.txBytes),
      catch: (cause) => decodeError({
        message: `The transaction digest could not be computed: ${cause instanceof Error ? cause.message : String(cause)}`,
      }, 'bytes'),
    })

    return yield* Schema.decodeUnknownEffect(Signed)({
      digest,
      bytes: toBase64(params.txBytes),
      signatures: [params.txSignature],
      sender,
      ...(data.expiration === null ? {} : { expiration: data.expiration }),
      chain: params.chainId,
    }).pipe(
      Effect.mapError((issue) => decodeError(issue, 'shape')),
    )
  })
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : fallback
}

function digestOf(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'digest' in error && typeof error.digest === 'string') {
    return error.digest
  }
  return undefined
}

function isTimeout(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ('name' in error && error.name === 'TimeoutError' || '_tag' in error && error._tag === 'TimeoutException'),
  )
}

/**
 * Co-signs the exact API-validated bytes once and delegates submission,
 * retries, journaling, and reconciliation to `sui-effect`.
 */
export async function executeTransaction(
  params: ExecutionParams,
): Promise<ExecutionOutcome> {
  const startedAt = Date.now()
  let signed: SignedTransaction | undefined
  let submissionStarted = false
  const executionBudgetMs = Math.max(1, params.executionTimeoutMs)
  const controller = new AbortController()
  // This deadline covers only the pre-send and execute phases. Once the Sui
  // node returns an execution envelope, Tx.submit owns the independent
  // visibility timeout and the request signal must stay alive long enough to
  // return the known applied result.
  const timeout = setTimeout(
    () => controller.abort(new Error('Transaction execution timed out.')),
    executionBudgetMs,
  )
  try {
    const perAttemptMs = Math.max(1, Math.floor(executionBudgetMs / 2))
    const program = Effect.gen(function* () {
      signed = yield* signedFromBytes(params)
      const fullySigned = yield* Tx.cosign(signed, params.sponsorSigner)
      signed = fullySigned
      const sui = yield* Sui
      const journal = yield* Journal
      const boundedJournal: JournalService = {
        put: (entry) => {
          if (entry._tag === 'Signed') return journal.put(entry)
          return journal.put(entry).pipe(
            Effect.timeout(Duration.millis(Math.max(1, params.confirmationTimeoutMs))),
            Effect.mapError((cause) => new JournalError({ cause })),
          )
        },
        get: journal.get,
        listUnresolved: journal.listUnresolved,
      }
      // Tx.submit writes its Signed journal record before it invokes the Sui
      // client. Mark the boundary from the actual execute call, so a timeout
      // or failure while that journal write is pending remains pre-submit.
      const trackedCore: typeof sui.core = {
        ...sui.core,
        executeTransaction: (options) => {
          submissionStarted = true
          return sui.core.executeTransaction(options).pipe(
            Effect.tap((result) =>
              Effect.result(
                Executed.fromTransactionResult(
                  result as Parameters<typeof Executed.fromTransactionResult>[0],
                ),
              ).pipe(
                Effect.map((checked) => {
                  // Only a schema-valid success or a schema-valid on-chain
                  // failure proves that Sui answered. A malformed envelope
                  // remains within the execute deadline and is reconciled as
                  // ambiguous by Tx.submit.
                  if (
                    checked._tag === 'Success' ||
                    (checked._tag === 'Failure' && checked.failure._tag === 'ExecutionFailed')
                  ) {
                    clearTimeout(timeout)
                  }
                }),
              ),
            ),
          )
        },
      }
      const trackedSui: typeof sui = { ...sui, core: trackedCore }
      return yield* Tx.submit(fullySigned).pipe(
        Effect.provideService(
          SubmitConfig,
          {
            ...SubmitConfig.defaults,
            awaitVisibility: params.waitForExecution,
            executeTimeout: Duration.millis(perAttemptMs),
            visibilityTimeout: Duration.millis(Math.max(1, params.confirmationTimeoutMs)),
            resubmitAttempts: 2,
            resubmit: Schedule.recurs(1),
          },
        ),
        Effect.provideService(Sui, trackedSui),
        Effect.provideService(Journal, boundedJournal),
      )
    })
    const result = await params.effectRuntime.runPromise(program, {
      signal: controller.signal,
    })
    return {
      kind: 'success',
      result,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const durationMs = Date.now() - startedAt
    if (error instanceof ExecutionFailed) {
      return { kind: 'chain_failed', result: error, durationMs }
    }
    if (error instanceof SubmissionUnknown) {
      return { kind: 'submission_unknown', error, durationMs }
    }
    if (error instanceof NotApplied || error instanceof BuildError || error instanceof DecodeError || error instanceof NetworkMismatch || error instanceof SigningError || error instanceof TransportError || (error && typeof error === 'object' && '_tag' in error && error._tag === 'JournalError')) {
      // Tx.submit only lets a TransportError escape for a node refusal such as
      // INVALID_ARGUMENT. Retryable transport loss is reconciled inside the
      // upstream lifecycle and arrives here as SubmissionUnknown already;
      // wrapping every TransportError after the execute marker would turn a
      // known pre-submit refusal into an ambiguous result.
      return { kind: 'not_applied', error: error as ExecutionError, durationMs }
    }

    const digest = digestOf(signed) ?? digestOf(error)
    if (isTimeout(error) || controller.signal.aborted) {
      if (signed !== undefined && submissionStarted) {
        return {
          kind: 'submission_unknown',
          error: new SubmissionUnknown({
            digest: signed.digest,
            signed,
            cause: error,
          }),
          durationMs,
        }
      }
      return {
        kind: 'execution_timeout',
        ...(digest === undefined ? {} : { digest }),
        durationMs,
        error: messageOf(error, 'Transaction execution timed out.'),
      }
    }
    if (signed !== undefined && submissionStarted) {
      return {
        kind: 'submission_unknown',
        error: new SubmissionUnknown({
          digest: signed.digest,
          signed,
          cause: error,
        }),
        durationMs,
      }
    }
    return {
      kind: 'execution_error',
      ...(digest === undefined ? {} : { digest }),
      durationMs,
      error: messageOf(error, 'Transaction execution failed.'),
    }
  } finally {
    clearTimeout(timeout)
  }
}
