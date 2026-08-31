import { describe, expect, test } from 'bun:test'
import { createBunRuntime } from './bun/runtime'
import { createCloudflareRuntime } from './cloudflare/runtime'

const environment = {
  SUI_NETWORK: 'testnet',
  SUI_GRPC_URL: 'https://fullnode.testnet.sui.io:443',
  SUI_PRIVATE_KEY:
    'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
  GAS_BUDGET_MAX: '1',
}

describe('platform adapters', () => {
  test('Cloudflare and Bun create equivalent sponsorship runtimes', () => {
    const cloudflare = createCloudflareRuntime(environment)
    const bun = createBunRuntime(environment)

    expect(cloudflare.environment).toEqual(bun.environment)
    expect(cloudflare.sponsorAddress).toBe(bun.sponsorAddress)
    expect(cloudflare.gasBudgetMax).toBe(bun.gasBudgetMax)
    expect(cloudflare.policies.allow.map((policy) => policy.name)).toEqual(
      bun.policies.allow.map((policy) => policy.name),
    )
  })
})
