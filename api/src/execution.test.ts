import { describe, expect, test } from 'bun:test'
import type { Signer as SdkSigner } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { Effect, Layer, ManagedRuntime } from 'effect'
import {
  DecodeError,
  JournalError,
  NetworkMismatch,
  Sui,
  type Sui as SuiService,
} from '@unconfirmed/sui-effect'
import {
  FakeOutcome,
  fakeDigest,
  layerTest,
  SuiCoreFake,
  type SuiCoreFakeState,
} from '@unconfirmed/sui-effect/testing'
import { Journal, Signer, type JournalService } from '@unconfirmed/sui-effect/tx'
import { executeTransaction, type ExecutionParams } from './execution'

const CHAIN_ID = fakeDigest(41)

type TestRuntime = ManagedRuntime.ManagedRuntime<SuiService, never>

type Fixture = {
  readonly runtime: TestRuntime
  readonly fake: SuiCoreFakeState
  readonly journal: JournalService
  readonly params: ExecutionParams
  readonly bytes: Uint8Array
  readonly sender: string
  readonly sponsor: Ed25519Keypair
  readonly getSignCount: () => number
}

async function fixture(
  execute: ReadonlyArray<ReturnType<typeof FakeOutcome.succeed> | ReturnType<typeof FakeOutcome.failWith> | ReturnType<typeof FakeOutcome.transportError>> = [
    FakeOutcome.succeed(),
  ],
  journal?: JournalService,
): Promise<Fixture> {
  const sender = new Ed25519Keypair()
  const sponsor = new Ed25519Keypair()
  const transaction = new Transaction()
  transaction.setSender(sender.toSuiAddress())
  transaction.setGasOwner(sponsor.toSuiAddress())
  transaction.setGasPayment([])
  transaction.setGasBudget(10_000_000)
  transaction.setGasPrice(1_000)
  transaction.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 1,
    },
  })
  transaction.moveCall({ target: '0x2::coin::zero' })
  const bytes = await transaction.build()
  const { signature } = await sender.signTransaction(bytes)

  let signCount = 0
  const sdkSigner = {
    toSuiAddress: () => sponsor.toSuiAddress(),
    getKeyScheme: () => sponsor.getKeyScheme(),
    signTransaction: async (value: Uint8Array) => {
      signCount += 1
      return sponsor.signTransaction(value)
    },
    signPersonalMessage: (value: Uint8Array) => sponsor.signPersonalMessage(value),
  } as unknown as SdkSigner
  const sponsorSigner = Signer.fromSdkSigner(sdkSigner)
  const script = {
    network: 'devnet' as const,
    chainId: CHAIN_ID,
    execute,
  }
  const journalService = journal ?? Journal.makeMemoryUnsafe()
  const journalLayer = Layer.succeed(Journal, journalService)
  const rawRuntime = ManagedRuntime.make(
    Layer.mergeAll(layerTest(script), journalLayer),
  )
  const fake = await rawRuntime.runPromise(SuiCoreFake)
  const runtime = rawRuntime as TestRuntime

  return {
    runtime,
    fake,
    journal: journalService,
    bytes,
    sender: sender.toSuiAddress(),
    sponsor,
    getSignCount: () => signCount,
    params: {
      effectRuntime: runtime,
      sponsorSigner,
      chainId: CHAIN_ID,
      sender: sender.toSuiAddress(),
      txBytes: bytes,
      txSignature: signature,
      waitForExecution: false,
      executionTimeoutMs: 3_000,
      confirmationTimeoutMs: 250,
    },
  }
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.runtime.dispose()
}

describe('executeTransaction', () => {
  test('signs once and retries exact bytes with the sender and sponsor signatures', async () => {
    const testFixture = await fixture([
      FakeOutcome.transportError('UNAVAILABLE'),
      FakeOutcome.succeed(),
    ])
    const outcome = await executeTransaction(testFixture.params)
    const calls = (await testFixture.runtime.runPromise(testFixture.fake.calls))
      .filter((call) => call.method === 'executeTransaction')
    expect(outcome.kind).toBe('success')
    expect(testFixture.getSignCount()).toBe(1)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      const options = call.options as {
        transaction: Uint8Array
        signatures: ReadonlyArray<string>
      }
      expect([...options.transaction]).toEqual([...testFixture.bytes])
      expect(options.signatures).toHaveLength(2)
    }
    expect(
      (calls[0]!.options as { signatures: ReadonlyArray<string> }).signatures,
    ).toEqual((calls[1]!.options as { signatures: ReadonlyArray<string> }).signatures)
    expect(await testFixture.runtime.runPromise(testFixture.journal.listUnresolved)).toHaveLength(0)
    await dispose(testFixture)
  })

  test('does not wait for visibility when waitForExecution is false', async () => {
    const testFixture = await fixture()
    const outcome = await executeTransaction(testFixture.params)
    const calls = await testFixture.runtime.runPromise(testFixture.fake.calls)
    expect(outcome.kind).toBe('success')
    expect(calls.some((call) => call.method === 'waitForTransaction')).toBe(false)
    await dispose(testFixture)
  })

  test('keeps applied evidence when visibility is slow or unavailable', async () => {
    const testFixture = await fixture()
    Object.assign(testFixture.fake.client.core, {
      waitForTransaction: ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })
    const outcome = await executeTransaction({
      ...testFixture.params,
      waitForExecution: true,
      executionTimeoutMs: 100,
      confirmationTimeoutMs: 25,
    })
    expect(outcome.kind).toBe('success')
    if (outcome.kind === 'success') expect(outcome.result.digest).toBeDefined()
    await dispose(testFixture)
  })

  test('reports an on-chain failure as applied', async () => {
    const testFixture = await fixture([
      FakeOutcome.failWith({
        message: 'Move aborted',
        $kind: 'MoveAbort',
        MoveAbort: { abortCode: '7' },
      }),
    ])
    const outcome = await executeTransaction(testFixture.params)
    expect(outcome.kind).toBe('chain_failed')
    if (outcome.kind === 'chain_failed') {
      expect(outcome.result.digest).toBeDefined()
      expect(outcome.result.reason.$kind).toBe('MoveAbort')
    }
    expect(await testFixture.runtime.runPromise(testFixture.journal.listUnresolved)).toHaveLength(0)
    await dispose(testFixture)
  })

  test('does not label a journal stall as submitted', async () => {
    const journalFailure = new JournalError({ cause: new Error('journal unavailable') })
    const blockingJournal: JournalService = {
      put: () => Effect.never,
      get: () => Effect.fail(journalFailure),
      listUnresolved: Effect.fail(journalFailure),
    }
    const testFixture = await fixture([FakeOutcome.succeed()], blockingJournal)
    const outcome = await executeTransaction({
      ...testFixture.params,
      executionTimeoutMs: 20,
      confirmationTimeoutMs: 20,
    })
    expect(outcome.kind).toBe('execution_timeout')
    const calls = await testFixture.runtime.runPromise(testFixture.fake.calls)
    expect(calls.some((call) => call.method === 'executeTransaction')).toBe(false)
    await dispose(testFixture)
  })

  test('labels an execute timeout as unknown once the Sui call has started', async () => {
    const testFixture = await fixture([FakeOutcome.timeoutThen(false)])
    const outcome = await executeTransaction({
      ...testFixture.params,
      executionTimeoutMs: 35,
      confirmationTimeoutMs: 10,
    })

    expect(outcome.kind).toBe('submission_unknown')
    if (outcome.kind === 'submission_unknown') {
      expect(outcome.error.digest).toBeDefined()
      expect(outcome.error.signed).toBeDefined()
    }
    const calls = (await testFixture.runtime.runPromise(testFixture.fake.calls))
      .filter((call) => call.method === 'executeTransaction')
    expect(calls.length).toBeGreaterThan(0)
    await dispose(testFixture)
  })

  test('keeps an explicit validator refusal not_applied after the execute marker', async () => {
    const testFixture = await fixture([FakeOutcome.transportError('INVALID_ARGUMENT')])
    const outcome = await executeTransaction(testFixture.params)

    expect(outcome.kind).toBe('not_applied')
    if (outcome.kind === 'not_applied') {
      expect(outcome.error._tag).toBe('TransportError')
    }
    const calls = (await testFixture.runtime.runPromise(testFixture.fake.calls))
      .filter((call) => call.method === 'executeTransaction')
    expect(calls).toHaveLength(1)
    await dispose(testFixture)
  })

  test('keeps applied success when terminal journal persistence stalls', async () => {
    const journalFailure = new JournalError({ cause: new Error('journal read unavailable') })
    const hangingJournal: JournalService = {
      put: (entry) => entry._tag === 'Signed' ? Effect.succeed(undefined) : Effect.never,
      get: () => Effect.fail(journalFailure),
      listUnresolved: Effect.fail(journalFailure),
    }
    const testFixture = await fixture([FakeOutcome.succeed()], hangingJournal)
    const outcome = await executeTransaction({
      ...testFixture.params,
      confirmationTimeoutMs: 10,
    })

    expect(outcome.kind).toBe('success')
    await dispose(testFixture)
  })

  test('keeps a slow signer inside the pre-submit timeout', async () => {
    const testFixture = await fixture()
    const delayedSigner = Signer.fromSdkSigner({
      toSuiAddress: () => testFixture.sponsor.toSuiAddress(),
      getKeyScheme: () => testFixture.sponsor.getKeyScheme(),
      signTransaction: async (bytes: Uint8Array) => {
        await Bun.sleep(50)
        return testFixture.sponsor.signTransaction(bytes)
      },
      signPersonalMessage: (bytes: Uint8Array) => testFixture.sponsor.signPersonalMessage(bytes),
    } as unknown as SdkSigner)
    const outcome = await executeTransaction({
      ...testFixture.params,
      sponsorSigner: delayedSigner,
      executionTimeoutMs: 10,
      confirmationTimeoutMs: 10,
    })

    expect(outcome.kind).toBe('execution_timeout')
    const calls = (await testFixture.runtime.runPromise(testFixture.fake.calls))
      .filter((call) => call.method === 'executeTransaction')
    expect(calls).toHaveLength(0)
    await dispose(testFixture)
  })

  test('does not classify an arbitrary signer error containing timeout text by substring', async () => {
    const testFixture = await fixture()
    const failingSigner = Signer.fromSdkSigner({
      toSuiAddress: () => testFixture.sponsor.toSuiAddress(),
      getKeyScheme: () => testFixture.sponsor.getKeyScheme(),
      signTransaction: async () => {
        throw new Error('timed out while preparing a key')
      },
      signPersonalMessage: (bytes: Uint8Array) => testFixture.sponsor.signPersonalMessage(bytes),
    } as unknown as SdkSigner)
    const outcome = await executeTransaction({
      ...testFixture.params,
      sponsorSigner: failingSigner,
    })

    expect(outcome.kind).toBe('not_applied')
    if (outcome.kind === 'not_applied') expect(outcome.error._tag).toBe('SigningError')
    await dispose(testFixture)
  })

  test('rejects a chain mismatch before any Sui call', async () => {
    const testFixture = await fixture()
    const outcome = await executeTransaction({
      ...testFixture.params,
      chainId: fakeDigest(99),
    })
    expect(outcome.kind).toBe('not_applied')
    if (outcome.kind === 'not_applied') expect(outcome.error).toBeInstanceOf(NetworkMismatch)
    const calls = await testFixture.runtime.runPromise(testFixture.fake.calls)
    expect(calls.some((call) => call.method === 'executeTransaction')).toBe(false)
    await dispose(testFixture)
  })

  test('reports malformed bytes as a pre-submit decode failure', async () => {
    const testFixture = await fixture()
    const outcome = await executeTransaction({
      ...testFixture.params,
      txBytes: new Uint8Array([1, 2, 3]),
    })
    expect(outcome.kind).toBe('not_applied')
    if (outcome.kind === 'not_applied') expect(outcome.error).toBeInstanceOf(DecodeError)
    await dispose(testFixture)
  })
})
