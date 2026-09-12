import { describe, expect, test } from 'bun:test'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { Effect, Layer, ManagedRuntime } from 'effect'
import {
  FakeOutcome,
  SuiCoreFake,
  fakeDigest,
  layerTest,
} from '@unconfirmed/sui-effect/testing'
import { Journal, Signer } from '@unconfirmed/sui-effect/tx'
import { ExecutionFailed, Sui, type Executed } from '@unconfirmed/sui-effect'
import { createOnaraApp } from './http/app'
import { createOnaraRuntime } from './core/runtime'
import { loadPolicies } from './policy'
import { OnaraError } from '../../sdk/src/errors'
import { onara } from '../../sdk/src'

const CHAIN_ID = fakeDigest(41)
const PACKAGE = normalizeSuiAddress('0x2')

const policyConfig = {
  version: 1 as const,
  policies: [
    {
      type: 'allow' as const,
      name: 'public',
      commands: { allowed: ['MoveCall' as const] },
      calls: { mode: 'set' as const, rules: [{ id: 'zero', targets: ['0x2::coin::zero'] }] },
    },
  ],
}

async function transactionFixture(
  sender: Ed25519Keypair,
  sponsor: Ed25519Keypair,
  nonce: number,
  target = '0x2::coin::zero',
) {
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
      nonce,
    },
  })
  transaction.moveCall({ target })
  const bytes = await transaction.build()
  const { signature } = await sender.signTransaction(bytes)
  return {
    sender: sender.toSuiAddress(),
    txBytes: toBase64(bytes),
    txSignature: signature,
  }
}

async function integrationFixture() {
  const sender = new Ed25519Keypair()
  const sponsor = new Ed25519Keypair()
  const event = {
    packageId: PACKAGE,
    module: 'coin',
    sender: sender.toSuiAddress(),
    eventType: '0x2::coin::TransferEvent',
    bcs: new Uint8Array([1, 2, 3, 4]),
    json: null,
  }
  const rawRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      layerTest({
        network: 'devnet',
        chainId: CHAIN_ID,
        epoch: 1n,
        simulate: [FakeOutcome.succeed()],
        execute: [
          FakeOutcome.succeed({
            events: [event],
            gasUsed: {
              computationCost: '11',
              storageCost: '22',
              storageRebate: '3',
              nonRefundableStorageFee: '4',
            },
          }),
          FakeOutcome.failWith({
            message: 'Move aborted',
            $kind: 'MoveAbort',
            MoveAbort: { abortCode: '7' },
          }),
        ],
      }),
      Journal.layerMemory,
    ),
  )
  const fake = await rawRuntime.runPromise(SuiCoreFake)
  const fakeClient = fake.client
  // The API intentionally uses the SDK's top-level read methods for status;
  // the fake exposes those reads at its Core boundary.
  Object.assign(fakeClient, {
    getBalance: (options: Parameters<typeof fakeClient.core.getBalance>[0]) =>
      fakeClient.core.getBalance(options),
    getTransaction: (options: Parameters<typeof fakeClient.core.getTransaction>[0]) =>
      fakeClient.core.getTransaction(options),
  })

  const runtime = createOnaraRuntime({
    environment: {
      SUI_NETWORK: 'devnet',
      SUI_CHAIN_ID: CHAIN_ID,
      SUI_GRPC_URL: 'https://sui.example.com',
      SUI_PRIVATE_KEY:
        'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
      GAS_BUDGET_MAX: '50000000',
    },
    config: policyConfig,
  })
  const fakeRuntime = rawRuntime as ManagedRuntime.ManagedRuntime<Sui, never>
  Object.assign(runtime, {
    client: fakeClient as unknown as SuiGrpcClient,
    keypair: sponsor,
    sponsorSigner: Signer.fromSdkSigner(sponsor),
    effectRuntime: fakeRuntime,
    sponsorAddress: sponsor.toSuiAddress(),
    policies: loadPolicies(policyConfig.policies),
  })

  const app = createOnaraApp(runtime)
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      return app.fetch(new Request(url, init))
    },
    { preconnect: () => {} },
  ) as typeof globalThis.fetch
  const client = fakeClient.$extend(
    onara({ url: 'https://onara.example.com', fetch, sui: { chainId: CHAIN_ID } }),
  )
  return {
    sender,
    sponsor,
    client,
    runtime,
    rawRuntime,
    configuredEffectRuntime: runtime.effectRuntime,
    fetch,
    event,
  }
}

describe('SDK to Hono sponsorship boundary', () => {
  test('returns a JSON-safe Executed receipt and preserves event bytes and gas evidence', async () => {
    const fixture = await integrationFixture()
    const request = await transactionFixture(fixture.sender, fixture.sponsor, 1)

    const result = await fixture.client.onara.sponsor(request)
    if (!('digest' in result)) throw new Error('expected an executed receipt')
    expect(result.digest).toBeDefined()
    expect(result.events).toHaveLength(1)
    expect([...result.events[0]!.bcs]).toEqual([1, 2, 3, 4])
    expect(result.effects.gasUsed.computationCost).toBe(11n as never)
    expect(result.effects.gasUsed.storageCost).toBe(22n as never)

    await fixture.client.onara.$dispose()
    await fixture.rawRuntime.dispose()
    await fixture.configuredEffectRuntime.dispose()
  })

  test('maps a policy refusal to a safe typed not_applied error', async () => {
    const fixture = await integrationFixture()
    const request = await transactionFixture(fixture.sender, fixture.sponsor, 3, '0x2::coin::one')

    const refusal = fixture.client.onara.sponsor(request)
    await expect(refusal).rejects.toBeInstanceOf(OnaraError)
    await expect(refusal).rejects.toMatchObject({
      _tag: 'OnaraError',
      status: 403,
      outcome: 'not_applied',
    })
    await fixture.client.onara.$dispose()
    await fixture.rawRuntime.dispose()
    await fixture.configuredEffectRuntime.dispose()
  })

  test('keeps applied chain failure terminal through submitVia and status lookup', async () => {
    const fixture = await integrationFixture()
    const request = await transactionFixture(fixture.sender, fixture.sponsor, 5)
    // Consume the first scripted success so the second request exercises the
    // API's 502 applied-failure envelope.
    await fixture.client.onara.sponsor(request)
    const failed = await transactionFixture(fixture.sender, fixture.sponsor, 6)

    await expect(fixture.client.onara.sponsor(failed)).rejects.toMatchObject({
      _tag: 'ExecutionFailed',
    })
    const digest = (await import('@mysten/sui/transactions')).TransactionDataBuilder
      .getDigestFromBytes((await import('@mysten/sui/utils')).fromBase64(failed.txBytes))
    const status = await fixture.client.onara.getTransactionStatus(digest)
    expect(status.found).toBe(true)
    if (!status.found) throw new Error('expected a found failed transaction status')
    expect('failure' in status).toBe(true)
    if (!('failure' in status)) throw new Error('expected an ExecutionFailed status branch')
    // The API and SDK can resolve distinct published package copies in a
    // workspace, so use the stable tagged-error contract at this boundary.
    expect(status.failure._tag).toBe('ExecutionFailed')
    expect(String(status.failure.digest)).toBe(digest)
    await fixture.client.onara.$dispose()
    await fixture.rawRuntime.dispose()
    await fixture.configuredEffectRuntime.dispose()
  })
})
