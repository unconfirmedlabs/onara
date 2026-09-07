import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computePolicyDigest } from '../core/policy-digest'

const cli = join(import.meta.dir, 'index.ts')
const config = { version: 1, policies: [{ type: 'deny', name: 'block', when: { kind: 'always' } }] }
function run(args: string[]) {
  return Bun.spawnSync([process.execPath, cli, ...args], { env: { ...process.env, SUI_PRIVATE_KEY: '', SUI_GRPC_URL: '' } })
}

describe('policy-digest CLI', () => {
  test('prints only the digest without requiring server environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onara-cli-'))
    try {
      const path = join(dir, 'config with spaces.json')
      writeFileSync(path, JSON.stringify(config, null, 2))
      const result = run(['policy-digest', path])
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe(`${computePolicyDigest(config)}\n`)
      expect(result.stderr.toString()).toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('fails cleanly for bad usage, missing files, malformed JSON and invalid policies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'onara-cli-'))
    try {
      const path = join(dir, 'config.json')
      for (const args of [[], ['unknown'], ['policy-digest'], ['policy-digest', path, 'extra'], ['policy-digest', join(dir, 'missing')]]) {
        const result = run(args)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout.toString()).toBe('')
        expect(result.stderr.toString().length).toBeGreaterThan(0)
      }
      for (const text of ['{', '{"version":2,"policies":[{}]}', '{"version":1,"policies":[{}]}', JSON.stringify({ version: 1, policies: [config.policies[0], config.policies[0]] })]) {
        writeFileSync(path, text)
        const result = run(['policy-digest', path])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout.toString()).toBe('')
        expect(result.stderr.toString().length).toBeGreaterThan(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
