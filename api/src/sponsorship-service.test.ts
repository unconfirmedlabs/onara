import { describe, expect, test } from 'bun:test'
import type { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { Effect, Layer, ManagedRuntime } from 'effect'
import {
  FakeOutcome,
  layerTest,
  SuiCoreFake,
  fakeDigest,
} from '@unconfirmed/sui-effect/testing'
import { Journal, Signer } from '@unconfirmed/sui-effect/tx'
import type { Sui } from '@unconfirmed/sui-effect'
import { loadPolicies } from './policy'
import {
  sponsorRequest,
  SponsorshipFailure,
  sponsorshipHttpStatus,
  type SponsorshipDependencies,
  type SponsorshipMode,
} from './sponsorship-service'

const policies = loadPolicies([
  {
    type: 'allow',
    name: 'public',
    commands: { allowed: ['MoveCall'] },
    calls: {
      mode: 'set',
      rules: [{ id: 'all', targets: ['*'] }],
    },
  },
])

const CHAIN_ID = fakeDigest(41)

async function fixture({
  mode,
  simulation,
}: {
  mode: SponsorshipMode
  simulation?: 'success' | 'failed' | 'unavailable'
}) {
  const sender = new Ed25519Keypair()
  const sponsor = new Ed25519Keypair()
  const transaction = new Transaction()
  transaction.setSender(sender.toSuiAddress())
  transaction.setGasOwner(sponsor.toSuiAddress())
  transaction.setGasPayment([])
  transaction.setGasBudget(10_000_000)
  transaction.setGasPrice(1_000)
  transaction.setExpiration({ Epoch: 2 })
  transaction.moveCall({ target: '0x2::coin::zero' })
  const bytes = await transaction.build()
  const { signature } = await sender.signTransaction(bytes)

  let simulationCalls = 0
  let executeCalls = 0
  let submittedBytes: Uint8Array | null = null
  const script = {
    network: 'devnet' as const,
    chainId: CHAIN_ID,
    epoch: 1n,
    simulate: simulation === 'unavailable'
      ? [FakeOutcome.transportError('UNAVAILABLE')]
      : simulation === 'failed'
        ? [FakeOutcome.failWith({
            message: 'Move abort',
            $kind: 'MoveAbort',
            MoveAbort: { abortCode: '1' },
          })]
        : [FakeOutcome.succeed()],
    execute: [FakeOutcome.succeed()],
  }
  const rawRuntime = ManagedRuntime.make(
    Layer.mergeAll(layerTest(script), Journal.layerMemory),
  )
  const fake = await rawRuntime.runPromise(SuiCoreFake)
  const client = fake.client as unknown as SuiGrpcClient
  const originalSimulation = fake.client.core.simulateTransaction
  const originalExecute = fake.client.core.executeTransaction
  Object.assign(fake.client.core, {
    simulateTransaction: async (options: Parameters<typeof originalSimulation>[0]) => {
      simulationCalls++
      if (simulation === 'failed') {
        return {
          $kind: 'FailedTransaction',
          FailedTransaction: {
            status: { error: { message: 'Move abort' } },
          },
        } as Awaited<ReturnType<typeof originalSimulation>>
      }
      return originalSimulation(options)
    },
    executeTransaction: async (options: Parameters<typeof originalExecute>[0]) => {
      executeCalls++
      submittedBytes = options.transaction
      return originalExecute(options)
    },
  })
  const sponsorSigner = Signer.fromSdkSigner(sponsor)
  const effectRuntime = rawRuntime as ManagedRuntime.ManagedRuntime<Sui, never>
  const dependencies: SponsorshipDependencies = {
    client,
    keypair: sponsor,
    effectRuntime,
    sponsorSigner,
    chainId: CHAIN_ID,
    sponsorAddress: sponsor.toSuiAddress(),
    policies,
    gasBudgetMax: null,
    forceValidateOnly: false,
  }
  const stages: string[] = []

  const run = (
    executionTimeoutMs = 3_000,
    waitForExecution = false,
    confirmationTimeoutMs = 1_000,
  ) =>
    sponsorRequest({
      request: {
        payload: {
          sender: sender.toSuiAddress(),
          txBytes: toBase64(bytes),
          txSignature: signature,
        },
        mode,
        waitForExecution,
        executionTimeoutMs,
        confirmationTimeoutMs,
      },
      dependencies,
      onStage: (stage, phase) => stages.push(`${stage}:${phase}`),
    })

  return {
    bytes,
    dependencies,
    run,
    stages,
    get simulationCalls() {
      return simulationCalls
    },
    get executeCalls() {
      return executeCalls
    },
    get submittedBytes() {
      return submittedBytes
    },
    dispose: () => rawRuntime.dispose(),
  }
}

describe('sponsorRequest', () => {
  test('validate-only mode cannot simulate, sign, or execute', async () => {
    const test = await fixture({ mode: 'validate-only' })
    const result = await test.run()

    expect(result.kind).toBe('validated')
    expect(test.simulationCalls).toBe(0)
    expect(test.executeCalls).toBe(0)
    expect(test.stages).toEqual([
      'guard:start',
      'guard:end',
      'signature:start',
      'signature:end',
      'context:start',
      'context:end',
      'policy:start',
      'policy:end',
      'ownership:start',
      'ownership:end',
      'suins:start',
      'suins:end',
    ])
  })

  test('trusted validate-only configuration overrides an execute request', async () => {
    const test = await fixture({ mode: 'execute' })
    test.dependencies.forceValidateOnly = true

    const result = await test.run()

    expect(result.kind).toBe('validated')
    expect(test.simulationCalls).toBe(0)
    expect(test.executeCalls).toBe(0)
  })

  test('simulates and submits the exact sender-signed bytes', async () => {
    const test = await fixture({ mode: 'execute' })
    const result = await test.run()

    expect(result.kind).toBe('executed')
    expect(test.simulationCalls).toBe(1)
    expect(test.executeCalls).toBe(1)
    expect(test.submittedBytes).not.toBeNull()
    expect([...test.submittedBytes!]).toEqual([...test.bytes])
    expect(test.stages.slice(-4)).toEqual([
      'simulation:start',
      'simulation:end',
      'execution:start',
      'execution:end',
    ])
  })

  test('simulation rejection and unavailability are distinct and never execute', async () => {
    const rejected = await fixture({
      mode: 'execute',
      simulation: 'failed',
    })
    await expect(rejected.run()).rejects.toMatchObject({
      kind: 'simulation-failed',
    })
    expect(rejected.executeCalls).toBe(0)

    const unavailable = await fixture({
      mode: 'execute',
      simulation: 'unavailable',
    })
    await expect(unavailable.run()).rejects.toMatchObject({
      kind: 'simulation-unavailable',
    })
    expect(unavailable.simulationCalls).toBe(2)
    expect(unavailable.executeCalls).toBe(0)
  })

  test('maps domain failures to HTTP status codes', () => {
    const invalid = new SponsorshipFailure(
      'invalid-transaction',
      'invalid',
    )
    const denied = new SponsorshipFailure('policy-denied', 'denied')
    const unavailable = new SponsorshipFailure(
      'simulation-unavailable',
      'unavailable',
    )
    const timeout = new SponsorshipFailure('request-timeout', 'timeout')

    expect(sponsorshipHttpStatus(invalid)).toBe(400)
    expect(sponsorshipHttpStatus(denied)).toBe(403)
    expect(sponsorshipHttpStatus(unavailable)).toBe(503)
    expect(sponsorshipHttpStatus(timeout)).toBe(504)
  })

  test('keeps policy mismatch diagnostics out of the public failure', async () => {
    const test = await fixture({ mode: 'validate-only' })
    test.dependencies.policies = loadPolicies([
      {
        type: 'allow',
        name: 'private-policy-name',
        commands: { allowed: ['MoveCall'] },
        calls: {
          mode: 'set',
          rules: [{ id: 'allowed', targets: ['0x3::allowed::call'] }],
        },
      },
    ])

    try {
      await test.run()
      throw new Error('Expected sponsorship to be denied.')
    } catch (error) {
      expect(error).toBeInstanceOf(SponsorshipFailure)
      expect(error).toMatchObject({
        kind: 'policy-denied',
        message: 'Transaction is not eligible for sponsorship.',
      })
      expect(sponsorshipHttpStatus(error as SponsorshipFailure)).toBe(403)
      expect((error as SponsorshipFailure).message).not.toContain(
        'private-policy-name',
      )
      expect((error as SponsorshipFailure).cause).toBeInstanceOf(Error)
      expect(((error as SponsorshipFailure).cause as Error).message).toContain(
        'private-policy-name',
      )
    }
  })

  test('a hung SuiNS lookup cannot block a matching branch without a SuiNS selector', async () => {
    const test = await fixture({ mode: 'validate-only' })
    test.dependencies.policies = loadPolicies([
      {
        type: 'allow',
        name: 'name-gated',
        suinsNames: ['*.onara.sui'],
        commands: { allowed: ['MoveCall'] },
        calls: { mode: 'set', rules: [{ id: 'all', targets: ['*'] }] },
      },
      {
        type: 'allow',
        name: 'not-name-gated',
        commands: { allowed: ['MoveCall'] },
        calls: { mode: 'set', rules: [{ id: 'all', targets: ['*'] }] },
      },
    ])
    let nameCalls = 0
    Object.assign(test.dependencies.client.core, {
      defaultNameServiceName: async () => {
        nameCalls++
        return new Promise(() => {})
      },
    })

    const result = await test.run()

    expect(result).toMatchObject({
      kind: 'validated',
      metadata: { policyName: 'not-name-gated' },
    })
    expect(nameCalls).toBe(0)
  })

  test('bounds a hung preflight stage with the request deadline', async () => {
    const test = await fixture({ mode: 'validate-only' })
    Object.assign(test.dependencies.client.core, {
      getCurrentSystemState: ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          if (signal?.aborted) {
            reject(signal.reason)
          } else {
            signal?.addEventListener(
              'abort',
              () => reject(signal.reason),
              { once: true },
            )
          }
        }),
    })

    await expect(test.run(25)).rejects.toMatchObject({
      kind: 'request-timeout',
    })
  })

  test('lets the independent visibility budget outlive the pre-submit deadline', async () => {
    const test = await fixture({ mode: 'execute' })
    Object.assign(test.dependencies.client.core, {
      waitForTransaction: ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    })

    const result = await test.run(100, true, 150)
    expect(result.kind).toBe('executed')
    if (result.kind === 'executed') expect(result.outcome.kind).toBe('success')
  })
})
