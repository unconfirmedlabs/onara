import { describe, expect, test } from 'bun:test'
import { parseOnaraConfig, parseOnaraConfigText } from './config'

describe('Onara configuration', () => {
  test('accepts a host-neutral policy envelope', () => {
    const config = parseOnaraConfig({
      version: 1,
      policies: [{ type: 'deny', name: 'disabled', enabled: false, when: { kind: 'always' } }],
    })

    expect(config.version).toBe(1)
    expect(config.policies).toHaveLength(1)
  })

  test('rejects adapter settings in the policy envelope', () => {
    expect(() =>
      parseOnaraConfig({ version: 1, policies: [{}], wrangler: {} }),
    ).toThrow(/Unrecognized key.*wrangler/)
  })

  test('reports invalid JSON separately', () => {
    expect(() => parseOnaraConfigText('{')).toThrow(
      /Invalid Onara configuration JSON/,
    )
  })
})
