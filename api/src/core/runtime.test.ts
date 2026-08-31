import { describe, expect, test } from 'bun:test'
import {
  assertOnaraRuntimeChainId,
  createOnaraRuntime,
} from './runtime'

const environment = {
  SUI_NETWORK: 'testnet',
  SUI_CHAIN_ID: 'test-chain',
  SUI_GRPC_URL: 'https://fullnode.testnet.sui.io:443',
  SUI_PRIVATE_KEY:
    'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
  GAS_BUDGET_MAX: '1',
}

const policies = [
  {
    type: 'allow',
    name: 'allow-all',
    gasBudgetMax: '1',
    commands: { allowed: ['MoveCall'] },
    calls: { mode: 'set', rules: [{ id: 'all', targets: ['*'] }] },
  },
]

describe('Onara runtime', () => {
  test('requires an explicit expected chain identifier', () => {
    const { SUI_CHAIN_ID: _, ...withoutChainId } = environment
    expect(() =>
      createOnaraRuntime({ environment: withoutChainId, policies }),
    ).toThrow('SUI_CHAIN_ID must be configured.')
  })

  test('rejects an RPC endpoint on the wrong chain', async () => {
    const runtime = createOnaraRuntime({ environment, policies })
    Object.assign(runtime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'wrong-chain' }),
    })

    await expect(assertOnaraRuntimeChainId(runtime)).rejects.toThrow(
      /SUI_CHAIN_ID mismatch/,
    )
  })

  test('accepts an RPC endpoint on the configured chain', async () => {
    const runtime = createOnaraRuntime({ environment, policies })
    Object.assign(runtime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }),
    })

    await expect(assertOnaraRuntimeChainId(runtime)).resolves.toBe('test-chain')
  })
})
