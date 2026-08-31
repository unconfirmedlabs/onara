import { describe, expect, test } from 'bun:test'
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
    policies: sponsorPolicies,
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
    })
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
    expect(await ready.json()).toEqual({ status: 'not-ready' })

    const status = await app.request('/status')
    expect(status.status).toBe(503)
    expect(await status.json()).toEqual({ error: 'Onara is not ready.' })
  })
})
