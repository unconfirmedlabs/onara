import { describe, expect, test } from 'bun:test'
import { computePolicyDigest } from './policy-digest'
import { version } from '../../package.json'
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
const config = { version: 1 as const, policies }

describe('Onara runtime', () => {
  test('requires an explicit expected chain identifier', () => {
    const { SUI_CHAIN_ID: _, ...withoutChainId } = environment
    expect(() =>
      createOnaraRuntime({ environment: withoutChainId, config }),
    ).toThrow('SUI_CHAIN_ID must be configured.')
  })

  test('rejects an RPC endpoint on the wrong chain', async () => {
    const runtime = createOnaraRuntime({ environment, config })
    Object.assign(runtime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'wrong-chain' }),
    })

    await expect(assertOnaraRuntimeChainId(runtime)).rejects.toThrow(
      /SUI_CHAIN_ID mismatch/,
    )
  })

  test('accepts an RPC endpoint on the configured chain', async () => {
    const runtime = createOnaraRuntime({ environment, config })
    Object.assign(runtime.client.core, {
      getChainIdentifier: async () => ({ chainIdentifier: 'test-chain' }),
    })

    await expect(assertOnaraRuntimeChainId(runtime)).resolves.toBe('test-chain')
  })

  test('retains a frozen raw snapshot and hashes independently of environment', () => {
    const input = structuredClone(config)
    const runtime = createOnaraRuntime({ environment, config: input })
    const digest = computePolicyDigest(input)
    input.policies[0]!.name = 'changed after initialization'
    expect(runtime.config).toEqual(config)
    expect(Object.isFrozen(runtime.config.policies[0])).toBe(true)
    expect(runtime.policyDigest).toBe(digest)
    expect(runtime.policyVersion).toBe(1)
    expect(runtime.engineVersion).toBe(version)
    expect(createOnaraRuntime({
      environment: { ...environment, GAS_BUDGET_MAX: '2', DRY_RUN_ONLY: 'true' },
      config,
    }).policyDigest).toBe(digest)
  })

  test('requires the complete valid envelope and policies', () => {
    for (const invalid of [policies, { policies }, { ...config, version: 2 }, { version: 1, policies: [{}] }]) {
      expect(() => createOnaraRuntime({ environment, config: invalid })).toThrow()
    }
  })
})
