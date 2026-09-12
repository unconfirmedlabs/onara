import { describe, expect, test } from 'bun:test'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions'
import { fromBase64, normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { ConfigProvider, Duration, Effect, Exit, Layer } from 'effect'
import type { Signer as SdkSigner } from '@mysten/sui/cryptography'
import {
  JournalError,
  NetworkMismatch,
  SubmissionUnknown,
} from '@unconfirmed/sui-effect'
import {
  FakeOutcome,
  fakeDigest,
  layerExtensionTest,
  layerTest,
  type FakeScript,
} from '@unconfirmed/sui-effect/testing'
import {
  Journal,
  SubmitConfig,
  type JournalService,
} from '@unconfirmed/sui-effect/tx'
import { Onara, onara } from '../src'
import type {
  OnaraLayerOptions,
  OnaraService,
  SponsorOptions,
  SponsorResponse,
  StatusResponse,
} from '../src'

const BASE_URL = 'https://onara.example.com'
const CHAIN_ID = fakeDigest(41)
const SPONSOR = normalizeSuiAddress('0x2')

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>

function mockFetch(handler: FetchHandler): typeof fetch {
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    return handler(url, init)
  }
  return Object.assign(fetcher, { preconnect: () => {} }) as typeof fetch
}

function statusResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    network: 'devnet',
    chainId: CHAIN_ID,
    address: SPONSOR,
    balances: { active: '123', pending: '456' },
    policyDigest: `sha256:${'a'.repeat(64)}`,
    policyVersion: 1,
    engineVersion: '0.3.0',
    ...overrides,
  })
}

function effectLayer(
  fetch: typeof globalThis.fetch,
  script: FakeScript = {},
  options: Partial<OnaraLayerOptions> = {},
) {
  const { url = BASE_URL, ...layerOptions } = options
  return layerExtensionTest(
    Onara.layerTest({ url, fetch, ...layerOptions }),
    { network: 'devnet', chainId: CHAIN_ID, ...script },
  )
}

function runOnara<A, E>(
  effect: Effect.Effect<A, E, Onara>,
  fetch: typeof globalThis.fetch,
  script: FakeScript = {},
  options: Partial<OnaraLayerOptions> = {},
): Promise<A> {
  const provided = Effect.provide(
    effect,
    effectLayer(fetch, script, options),
    { local: true },
  )
  return Effect.runPromise(
    Effect.provideService(provided, SubmitConfig, {
      ...SubmitConfig.defaults,
      reconcileRecheck: Duration.zero,
    }),
  )
}

function serviceEffect<A>(f: (service: OnaraService) => Effect.Effect<A, unknown, never>) {
  return Effect.gen(function* () {
    const service = yield* Onara
    return yield* f(service)
  })
}

async function signedFixture(maxEpoch = '2') {
  const sender = new Ed25519Keypair()
  const transaction = new Transaction()
  transaction.setSender(sender.toSuiAddress())
  transaction.setGasOwner(SPONSOR)
  transaction.setGasPayment([])
  transaction.setGasBudget(10_000_000)
  transaction.setGasPrice(1_000)
  transaction.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch,
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 1,
    },
  })
  transaction.moveCall({ target: '0x2::coin::zero' })
  const bytes = await transaction.build()
  const { signature } = await sender.signTransaction(bytes)
  return {
    sender: sender.toSuiAddress(),
    txBytes: toBase64(bytes),
    txSignature: signature,
  }
}

describe('Onara Effect service', () => {
  test('decodes complete status metadata through the upstream test layer', async () => {
    const fetch = mockFetch((url) => {
      expect(url).toBe(`${BASE_URL}/status`)
      return statusResponse()
    })
    const result = await runOnara(
      serviceEffect((service) => service.status),
      fetch,
    )

    expect(result).toEqual({
      network: 'devnet',
      chainId: CHAIN_ID,
      address: SPONSOR,
      balances: { active: '123', pending: '456' },
      policyDigest: `sha256:${'a'.repeat(64)}`,
      policyVersion: 1,
      engineVersion: '0.3.0',
    })
  })

  test('builds layerConfig from ONARA_URL and reports missing or malformed config', async () => {
    const resolveLayer = (values: Record<string, string>) =>
      Effect.runPromiseExit(
        Effect.provide(
          Effect.map(Onara, () => true),
          Layer.mergeAll(
            Onara.layerConfig.pipe(
              Layer.provide(
                ConfigProvider.layer(ConfigProvider.fromEnvRecord(values)),
              ),
            ),
            Layer.empty,
          ).pipe(Layer.provide(layerTest({
            network: 'devnet',
            chainId: CHAIN_ID,
          }))),
          { local: true },
        ),
      )

    const valid = await resolveLayer({ ONARA_URL: BASE_URL })
    expect(Exit.isSuccess(valid)).toBe(true)

    const missing = await resolveLayer({})
    expect(Exit.isFailure(missing)).toBe(true)

    const malformed = await resolveLayer({ ONARA_URL: 'not a URL' })
    expect(Exit.isFailure(malformed)).toBe(true)
  })

  test('sends exact bytes, signature, sender and dry-run query without a journal or Sui execute', async () => {
    const fixture = await signedFixture()
    let postCount = 0
    let journalPuts = 0
    const journalStore = Journal.makeMemoryUnsafe()
    const journal: JournalService = {
      ...journalStore,
      put: (entry) => Effect.tap(journalStore.put(entry), () =>
        Effect.sync(() => {
          journalPuts += 1
        }),
      ),
    }
    const fetch = mockFetch((url, init) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/status') return statusResponse()
      expect(parsed.pathname).toBe('/sponsor')
      expect(parsed.searchParams.get('dryRun')).toBe('true')
      expect(parsed.searchParams.has('waitForExecution')).toBe(false)
      expect(init?.method).toBe('POST')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(JSON.parse(init?.body as string)).toEqual(fixture)
      postCount += 1
      return Response.json({ dryRun: true, policy: 'public', moveCallTargets: ['0x2::coin::zero'] })
    })

    const result = await runOnara(
      serviceEffect((service) => service.sponsor({ ...fixture, dryRun: true, simulate: false })),
      fetch,
      { execute: [] },
      { journal },
    )
    expect(result).toEqual({
      dryRun: true,
      policy: 'public',
      moveCallTargets: ['0x2::coin::zero'],
    })
    expect(postCount).toBe(1)
    expect(journalPuts).toBe(0)
  })

  test('waitForExecution=false is sent while simulate remains a compatibility-only option', async () => {
    const fixture = await signedFixture()
    const fetch = mockFetch((url, init) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/status') return statusResponse()
      expect(parsed.searchParams.get('waitForExecution')).toBe('false')
      expect(parsed.searchParams.has('simulate')).toBe(false)
      expect(JSON.parse(init?.body as string)).toEqual(fixture)
      // This reduced envelope is enough for Executed.fromPartial.
      const digest = TransactionDataBuilder.getDigestFromBytes(fromBase64(fixture.txBytes))
      return Response.json({
        digest,
        effects: { transactionDigest: digest },
      })
    })

    const result = await runOnara(
      serviceEffect((service) => service.sponsor({ ...fixture, waitForExecution: false, simulate: false })),
      fetch,
    )
    expect(result).toMatchObject({
      digest: TransactionDataBuilder.getDigestFromBytes(fromBase64(fixture.txBytes)),
    })
  })

  test('high-level sponsorship overwrites gas payment and preserves bounded signed bytes', async () => {
    const signer = new Ed25519Keypair()
    const transaction = new Transaction()
    transaction.setGasOwner(normalizeSuiAddress('0x9'))
    transaction.setGasPayment([
      {
        objectId: normalizeSuiAddress('0x8'),
        version: '1',
        digest: CHAIN_ID,
      },
    ])
    transaction.setGasBudget(10_000_000)
    transaction.setGasPrice(1_000)
    transaction.moveCall({ target: '0x2::coin::zero' })
    let posted = 0
    const fetch = mockFetch((url, init) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/status') return statusResponse()
      posted += 1
      const payload = JSON.parse(init?.body as string) as {
        sender: string
        txBytes: string
        txSignature: string
      }
      const bytes = fromBase64(payload.txBytes)
      const data = TransactionDataBuilder.fromBytes(bytes)
      expect(payload.sender).toBe(signer.toSuiAddress())
      expect(data.sender).toBe(signer.toSuiAddress())
      expect(data.gasData.owner).toBe(SPONSOR)
      expect(data.gasData.payment).toEqual([])
      expect(data.expiration?.$kind).toBe('ValidDuring')
      expect(payload.txSignature).toBeDefined()
      return Response.json({
        digest: TransactionDataBuilder.getDigestFromBytes(bytes),
        effects: {
          transactionDigest: TransactionDataBuilder.getDigestFromBytes(bytes),
        },
      })
    })
    const result = await runOnara(
      serviceEffect((service) =>
        service.sponsorTransaction({ transaction, signer }),
      ),
      fetch,
      { simulate: [FakeOutcome.succeed()] },
    )
    expect(result).toMatchObject({ digest: expect.any(String) })
    expect(posted).toBe(1)
  })

  test('high-level sponsorship accepts a composable recipe', async () => {
    const signer = new Ed25519Keypair()
    const recipe = (tx: Transaction) => {
      tx.moveCall({ target: '0x2::coin::zero' })
    }
    let posted = 0
    const fetch = mockFetch((url, init) => {
      const path = new URL(url).pathname
      if (path === '/status') return statusResponse()
      posted += 1
      const body = JSON.parse(init?.body as string) as { txBytes: string }
      const digest = TransactionDataBuilder.getDigestFromBytes(fromBase64(body.txBytes))
      return Response.json({ digest, effects: { transactionDigest: digest } })
    })
    const result = await runOnara(
      serviceEffect((service) =>
        service.sponsorTransaction({ transaction: recipe, signer }),
      ),
      fetch,
      { simulate: [FakeOutcome.succeed()] },
    )
    expect(result).toMatchObject({ digest: expect.any(String) })
    expect(posted).toBe(1)
  })

  test('simulation failure prevents high-level signing and HTTP submission', async () => {
    const keypair = new Ed25519Keypair()
    let signCount = 0
    const signer = {
      toSuiAddress: () => keypair.toSuiAddress(),
      getKeyScheme: () => keypair.getKeyScheme(),
      signTransaction: async (bytes: Uint8Array) => {
        signCount += 1
        return keypair.signTransaction(bytes)
      },
      signPersonalMessage: (bytes: Uint8Array) => keypair.signPersonalMessage(bytes),
    } as unknown as SdkSigner
    const transaction = new Transaction()
    transaction.moveCall({ target: '0x2::coin::zero' })
    let postCount = 0
    const fetch = mockFetch((url) => {
      if (new URL(url).pathname === '/status') return statusResponse()
      postCount += 1
      return Response.json({ digest: CHAIN_ID, effects: { transactionDigest: CHAIN_ID } })
    })
    await expect(
      runOnara(
        serviceEffect((service) =>
          service.sponsorTransaction({ transaction, signer }),
        ),
        fetch,
        {
          simulate: [
            FakeOutcome.failWith({
              message: 'Move abort',
              $kind: 'MoveAbort',
              MoveAbort: { abortCode: '1' },
            }),
          ],
        },
      ),
    ).rejects.toMatchObject({ _tag: 'SimulationFailed' })
    expect(signCount).toBe(0)
    expect(postCount).toBe(0)
  })

  test('rejects a server chain mismatch before high-level signing or posting', async () => {
    const keypair = new Ed25519Keypair()
    let signCount = 0
    const signer = {
      toSuiAddress: () => keypair.toSuiAddress(),
      getKeyScheme: () => keypair.getKeyScheme(),
      signTransaction: async (bytes: Uint8Array) => {
        signCount += 1
        return keypair.signTransaction(bytes)
      },
      signPersonalMessage: (bytes: Uint8Array) => keypair.signPersonalMessage(bytes),
    } as unknown as SdkSigner
    const transaction = new Transaction()
    transaction.moveCall({ target: '0x2::coin::zero' })
    let postCount = 0
    const fetch = mockFetch((url) => {
      if (new URL(url).pathname === '/status') {
        return statusResponse({ chainId: fakeDigest(99) })
      }
      postCount += 1
      return Response.json({ digest: CHAIN_ID, effects: { transactionDigest: CHAIN_ID } })
    })
    await expect(
      runOnara(
        serviceEffect((service) =>
          service.sponsorTransaction({ transaction, signer }),
        ),
        fetch,
      ),
    ).rejects.toBeInstanceOf(NetworkMismatch)
    expect(signCount).toBe(0)
    expect(postCount).toBe(0)
  })

  test('uses a real Response body once and preserves explicit refusal outcome', async () => {
    const fixture = await signedFixture()
    const fetch = mockFetch((url) => {
      if (url.endsWith('/status')) return statusResponse()
      return Response.json(
        { error: 'policy denied', outcome: 'not_applied' as const },
        { status: 400 },
      )
    })

    await expect(
      runOnara(
        serviceEffect((service) => service.sponsor(fixture)),
        fetch,
      ),
    ).rejects.toMatchObject({
      _tag: 'OnaraError',
      status: 400,
      outcome: 'not_applied',
      message: 'policy denied',
    })
  })

  test('honors an explicit not_applied outcome even on an HTTP 503', async () => {
    const fixture = await signedFixture()
    let postCount = 0
    const fetch = mockFetch((url) => {
      const path = new URL(url).pathname
      if (path === '/status') return statusResponse()
      postCount += 1
      return Response.json(
        { error: 'simulation unavailable', outcome: 'not_applied' as const },
        { status: 503 },
      )
    })
    await expect(
      runOnara(
        serviceEffect((service) => service.sponsor(fixture)),
        fetch,
        { getTransaction: [FakeOutcome.transportError('INVALID_ARGUMENT')] },
      ),
    ).rejects.toMatchObject({
      _tag: 'OnaraError',
      status: 503,
      outcome: 'not_applied',
    })
    expect(postCount).toBe(1)
  })

  test('maps a rejected fetch to a typed transport error', async () => {
    const fetch = mockFetch(() => {
      throw new TypeError('network unavailable')
    })
    await expect(
      runOnara(serviceEffect((service) => service.status), fetch),
    ).rejects.toMatchObject({
      _tag: 'TransportError',
      method: 'Onara.status',
    })
  })

  test('does not reconcile an explicit validation-only response for an execute request', async () => {
    const fixture = await signedFixture()
    let postCount = 0
    const fetch = mockFetch((url) => {
      const path = new URL(url).pathname
      if (path === '/status') return statusResponse()
      postCount += 1
      return Response.json({
        dryRun: true,
        policy: 'public',
        moveCallTargets: ['0x2::coin::zero'],
      })
    })
    const result = await runOnara(
      serviceEffect((service) => service.sponsor(fixture)),
      fetch,
      // An accidental reconcile would hit this refusal and fail; the
      // successful validation response must be returned directly.
      {
        execute: [],
        getTransaction: [FakeOutcome.transportError('INVALID_ARGUMENT')],
      },
    )
    expect(result).toEqual({
      dryRun: true,
      policy: 'public',
      moveCallTargets: ['0x2::coin::zero'],
    })
    expect(postCount).toBe(1)
  })

  test('reconciles an ambiguous HTTP failure once with the original signed bytes', async () => {
    const fixture = await signedFixture('1000')
    let postCount = 0
    const fetch = mockFetch((url) => {
      const path = new URL(url).pathname
      if (path === '/status') return statusResponse()
      postCount += 1
      return Response.json(
        { error: 'relay response lost', outcome: 'unknown' as const },
        { status: 502 },
      )
    })
    try {
      await runOnara(
        serviceEffect((service) => service.sponsor(fixture)),
        fetch,
        // The relay failure is ambiguous; a non-retryable read error keeps
        // this regression fast while still proving reconciliation occurred.
        { getTransaction: [FakeOutcome.transportError('INVALID_ARGUMENT')] },
      )
      throw new Error('expected an ambiguous submission')
    } catch (error) {
      expect(error).toMatchObject({ _tag: 'SubmissionUnknown' })
      const signed = (error as SubmissionUnknown).signed
      expect(signed).toBeDefined()
      expect([...signed!.bytes]).toEqual([...fromBase64(fixture.txBytes)])
    }
    expect(postCount).toBe(1)
  })

  test('treats malformed post-submit JSON as ambiguous instead of a refusal', async () => {
    const fixture = await signedFixture('1000')
    let postCount = 0
    const fetch = mockFetch((url) => {
      const path = new URL(url).pathname
      if (path === '/status') return statusResponse()
      postCount += 1
      return new Response('{not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    await expect(
      runOnara(
        serviceEffect((service) => service.sponsor(fixture)),
        fetch,
        { getTransaction: [FakeOutcome.transportError('INVALID_ARGUMENT')] },
      ),
    ).rejects.toMatchObject({ _tag: 'SubmissionUnknown' })
    expect(postCount).toBe(1)
  })

  test('journals before HTTP and leaves the network untouched when the journal fails', async () => {
    const fixture = await signedFixture()
    let postCount = 0
    const fetch = mockFetch((url) => {
      if (new URL(url).pathname === '/status') return statusResponse()
      postCount += 1
      return Response.json({ digest: CHAIN_ID, effects: { transactionDigest: CHAIN_ID } })
    })
    const journalFailure = new JournalError({ cause: new Error('journal unavailable') })
    const journal: JournalService = {
      put: () => Effect.fail(journalFailure),
      get: () => Effect.fail(journalFailure),
      listUnresolved: Effect.fail(journalFailure),
    }
    await expect(
      runOnara(
        serviceEffect((service) => service.sponsor(fixture)),
        fetch,
        {},
        { journal },
      ),
    ).rejects.toMatchObject({ _tag: 'JournalError' })
    expect(postCount).toBe(0)
  })

  test('registered Promise face shares the service and can be disposed and reinitialized', async () => {
    let statusCalls = 0
    const fetch = mockFetch((url) => {
      expect(url).toBe(`${BASE_URL}/status`)
      statusCalls += 1
      return statusResponse()
    })
    const client = new SuiGrpcClient({ network: 'devnet', baseUrl: 'https://sui.example.com' })
    Object.assign(client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: CHAIN_ID }),
    })
    const extended = client.$extend(
      onara({ url: `${BASE_URL}/`, name: 'sponsor', fetch, sui: { chainId: CHAIN_ID } }),
    )

    await extended.sponsor.$ready()
    await expect(extended.sponsor.status()).resolves.toMatchObject({ chainId: CHAIN_ID })
    await extended.sponsor.$dispose()
    await expect(extended.sponsor.status()).resolves.toMatchObject({ chainId: CHAIN_ID })
    expect(statusCalls).toBe(2)
  })

  test('rejects a malformed chain identifier instead of treating it as a status', async () => {
    const fetch = mockFetch((url) =>
      url.endsWith('/status') ? statusResponse({ chainId: 'not-a-chain' }) : Response.error(),
    )
    await expect(
      runOnara(serviceEffect((service) => service.status), fetch),
    ).rejects.toMatchObject({ _tag: 'DecodeError', kind: 'shape' })
  })

  test('treats only an explicit 404 envelope as absent and preserves status outages', async () => {
    const missing = mockFetch((url) => {
      if (new URL(url).pathname === '/status') return statusResponse()
      return Response.json(
        { found: false, digest: CHAIN_ID },
        { status: 404 },
      )
    })
    await expect(
      runOnara(
        serviceEffect((service) => service.getTransactionStatus(CHAIN_ID)),
        missing,
      ),
    ).resolves.toEqual({ found: false, digest: CHAIN_ID })

    const outage = mockFetch((url) => {
      if (new URL(url).pathname === '/status') return statusResponse()
      return Response.json(
        { error: 'RPC unavailable', digest: CHAIN_ID, outcome: 'unknown' as const },
        { status: 503 },
      )
    })
    await expect(
      runOnara(
        serviceEffect((service) => service.getTransactionStatus(CHAIN_ID)),
        outage,
      ),
    ).rejects.toMatchObject({
      _tag: 'OnaraError',
      status: 503,
      digest: CHAIN_ID,
      outcome: 'unknown',
    })

    const mismatched = mockFetch((url) => {
      if (new URL(url).pathname === '/status') return statusResponse()
      const otherDigest = fakeDigest(99)
      return Response.json({
        found: true,
        digest: otherDigest,
        effects: { transactionDigest: otherDigest },
      })
    })
    await expect(
      runOnara(
        serviceEffect((service) => service.getTransactionStatus(CHAIN_ID)),
        mismatched,
      ),
    ).rejects.toMatchObject({ _tag: 'DecodeError' })
  })

  test('keeps the low-level API type exact at compile time', () => {
    const serviceMethod: OnaraService['sponsor'] = (options) =>
      Effect.succeed({ dryRun: true, policy: options.sender, moveCallTargets: [] })
    expect(typeof serviceMethod).toBe('function')
    const _clientType: ClientWithCoreApi = new SuiGrpcClient({
      network: 'devnet',
      baseUrl: 'https://sui.example.com',
    })
    expect(_clientType).toBeDefined()

    const extended = _clientType.$extend(onara({ url: BASE_URL }))
    const status: () => Promise<StatusResponse> = extended.onara.status
    const sponsor: (options: SponsorOptions) => Promise<SponsorResponse> =
      extended.onara.sponsor
    expect(typeof status).toBe('function')
    expect(typeof sponsor).toBe('function')
  })
})
