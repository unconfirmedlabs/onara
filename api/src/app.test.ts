import { describe, expect, test } from 'bun:test'
import { TransactionError } from '@mysten/sui/client'
import { createOnaraRuntime, type OnaraRuntime } from './core/runtime'
import { createOnaraApp } from './http/app'
import sponsorPolicies from '../policies'

function runtime(): OnaraRuntime {
  return createOnaraRuntime({
    environment: {
      SUI_NETWORK: 'testnet',
      SUI_CHAIN_ID: 'test-chain',
      SUI_GRPC_URL: 'https://fullnode.testnet.sui.io:443',
      SUI_PRIVATE_KEY:
        'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
      GAS_BUDGET_MAX: '1',
    },
    config: sponsorPolicies,
  })
}

describe('HTTP surface', () => {
  test('does not expose policy configuration', async () => {
    const app = createOnaraApp(runtime())
    const response = await app.request('/policies')

    expect(response.status).toBe(404)
  })

  test('separates liveness from time-bounded readiness', async () => {
    const appRuntime = runtime()
    Object.assign(appRuntime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }),
      getCurrentSystemState: async () => ({ systemState: { epoch: '1' } }),
    })
    const app = createOnaraApp(appRuntime)

    expect((await app.request('/livez')).status).toBe(200)

    const ready = await app.request('/readyz')
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({
      status: 'ready',
      network: 'testnet',
      chainId: 'test-chain',
      policyDigest: appRuntime.policyDigest,
      policyVersion: appRuntime.policyVersion,
      engineVersion: appRuntime.engineVersion,
    })
    expect(ready.headers.get('Cache-Control')).toBe('no-store')
  })

  test('reports the same policy identity in status and readiness without exposing configuration', async () => {
    const appRuntime = runtime()
    Object.assign(appRuntime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }),
      getCurrentSystemState: async () => ({ systemState: { epoch: '1' } }),
    })
    Object.assign(appRuntime.client, {
      getBalance: async () => ({ balance: { addressBalance: '123', coinBalance: '456' } }),
    })
    const app = createOnaraApp(appRuntime)
    const response = await app.request('/status')
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      network: 'testnet', chainId: 'test-chain', address: appRuntime.sponsorAddress,
      balances: { active: '123', pending: '456' },
      policyDigest: appRuntime.policyDigest, policyVersion: 1,
      engineVersion: appRuntime.engineVersion,
    })
    expect(await (await app.request('/livez')).json()).toEqual({ status: 'live' })
  })

  test('returns 503 when a readiness check times out', async () => {
    const appRuntime = runtime()
    Object.assign(appRuntime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }),
      getCurrentSystemState: ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    })
    Object.assign(appRuntime.client, {
      getBalance: ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    })
    const app = createOnaraApp(appRuntime, { readinessTimeoutMs: 1 })

    const ready = await app.request('/readyz')
    expect(ready.status).toBe(503)
    expect(ready.headers.get('Cache-Control')).toBe('no-store')
    expect(await ready.json()).toEqual({ status: 'not-ready', outcome: 'not_applied' })

    const status = await app.request('/status')
    expect(status.status).toBe(503)
    expect(status.headers.get('Cache-Control')).toBe('no-store')
    expect(await status.json()).toEqual({ error: 'Onara is not ready.', outcome: 'not_applied' })
  })

  test('distinguishes a real missing transaction from a status RPC outage', async () => {
    const digest = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'
    const missingRuntime = runtime()
    Object.assign(missingRuntime.client, {
      getTransaction: async () => {
        throw new TransactionError('notFound', digest)
      },
    })
    const missing = await createOnaraApp(missingRuntime).request(
      `/sponsor/${digest}/status`,
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ found: false, digest })

    const outageRuntime = runtime()
    Object.assign(outageRuntime.client, {
      getTransaction: async () => {
        throw new Error('RPC unavailable')
      },
    })
    const outage = await createOnaraApp(outageRuntime).request(
      `/sponsor/${digest}/status`,
    )
    expect(outage.status).toBe(503)
    expect(await outage.json()).toEqual({
      error: 'Unable to look up transaction status.',
      outcome: 'unknown',
      digest,
    })
    await missingRuntime.effectRuntime.dispose()
    await outageRuntime.effectRuntime.dispose()
  })
})
