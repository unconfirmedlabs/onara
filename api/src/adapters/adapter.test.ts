import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { createBunRuntime } from './bun/runtime'
import { createCloudflareRuntime } from './cloudflare/runtime'

const environment = {
  SUI_NETWORK: 'testnet',
  SUI_CHAIN_ID: 'test-chain',
  SUI_GRPC_URL: 'https://fullnode.testnet.sui.io:443',
  SUI_PRIVATE_KEY:
    'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
  GAS_BUDGET_MAX: '1',
}

describe('platform adapters', () => {
  test('Bun rejects an implicit in-tree policy registry', () => {
    expect(() => createBunRuntime(environment)).toThrow(/ONARA_CONFIG_PATH/)
  })

  test('Cloudflare and Bun create equivalent sponsorship runtimes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'onara-adapter-test-'))
    const configPath = join(directory, 'config.json')
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        policies: [
          {
            type: 'allow',
            name: 'allow-all',
            gasBudgetMax: '1',
            commands: { allowed: ['MoveCall'] },
            calls: { mode: 'set', rules: [{ id: 'all', targets: ['*'] }] },
          },
        ],
      }),
    )

    try {
    const cloudflare = createCloudflareRuntime(environment)
      const bun = createBunRuntime({ ...environment, ONARA_CONFIG_PATH: configPath })

      expect(cloudflare.environment.SUI_NETWORK).toBe(bun.environment.SUI_NETWORK)
      expect(cloudflare.environment.SUI_CHAIN_ID).toBe(bun.environment.SUI_CHAIN_ID)
      expect(cloudflare.environment.SUI_GRPC_URL).toBe(bun.environment.SUI_GRPC_URL)
      expect(cloudflare.sponsorAddress).toBe(bun.sponsorAddress)
      expect(cloudflare.gasBudgetMax).toBe(bun.gasBudgetMax)
      expect(cloudflare.policies.allow.map((policy) => policy.name)).toEqual(
        bun.policies.allow.map((policy) => policy.name),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
