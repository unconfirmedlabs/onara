import { describe, expect, test } from 'bun:test'
import { createOnaraRuntime } from './core/runtime'
import { createOnaraApp } from './http/app'
import sponsorPolicies from '../policies'

const app = createOnaraApp(
  createOnaraRuntime({
    environment: {
      SUI_NETWORK: 'testnet',
      SUI_GRPC_URL: 'https://fullnode.testnet.sui.io:443',
      SUI_PRIVATE_KEY:
        'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
      GAS_BUDGET_MAX: '1',
    },
    policies: sponsorPolicies,
  }),
)

describe('HTTP surface', () => {
  test('does not expose policy configuration', async () => {
    const response = await app.request('/policies')

    expect(response.status).toBe(404)
  })
})
