import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { canonicalizeJson, computePolicyDigest } from './policy-digest'

const deny = { type: 'deny', name: 'block', when: { kind: 'always' } }
const config = { version: 1, policies: [deny] }

describe('canonical policy digest', () => {
  test('matches a fixed independently hashed canonical JSON vector', () => {
    const canonical = '{"policies":[{"name":"block","type":"deny","when":{"kind":"always"}}],"version":1}'
    expect(canonicalizeJson(config)).toBe(canonical)
    expect(computePolicyDigest(config)).toBe('sha256:e036cbfa96dfd9b31ebaa62569a34cd1da8c09ea13b5147d97e01c91fec84cc0')
    expect(computePolicyDigest(config)).toBe(`sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`)
    expect(computePolicyDigest(config)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test('sorts recursively including numeric-looking and UTF-16 keys', () => {
    expect(canonicalizeJson({ z: { '2': 2, '10': 10 }, a: [false, null, 'é\n"'] }))
      .toBe('{"a":[false,null,"é\\n\\\""],"z":{"10":10,"2":2}}')
    expect(canonicalizeJson({ '\uE000': 1, '😀': 2 })).toBe('{"😀":2,"\uE000":1}')
    expect(canonicalizeJson({ b: 2, a: 1 })).toBe(canonicalizeJson({ a: 1, b: 2 }))
    expect(canonicalizeJson({ n: -0, e: 1e21 })).toBe('{"e":1e+21,"n":0}')
  })

  test('hashes integer-like policy type-argument keys in lexical order', () => {
    const policyConfig = {
      version: 1,
      policies: [{
        type: 'allow', name: 'typed', gasBudgetMax: '1',
        commands: { allowed: ['MoveCall'] },
        calls: { mode: 'set', rules: [{ id: 'call', targets: ['0x1::m::f'], typeArguments: { '2': ['0x2::sui::SUI'], '10': ['0x1::m::T'] } }] },
      }],
    }
    const canonical = canonicalizeJson(policyConfig)
    expect(canonical).toContain('"typeArguments":{"10":["0x1::m::T"],"2":["0x2::sui::SUI"]}')
    expect(computePolicyDigest(policyConfig)).toBe(`sha256:${createHash('sha256').update(canonical).digest('hex')}`)
  })

  test('ignores formatting and object key order but retains raw defaults and array order', () => {
    expect(computePolicyDigest(JSON.parse(' { "policies": [{"when":{"kind":"always"},"name":"block","type":"deny"}], "version":1 } ')))
      .toBe(computePolicyDigest(config))
    expect(computePolicyDigest({ ...config, policies: [{ ...deny, enabled: true }] }))
      .not.toBe(computePolicyDigest(config))
    const other = { ...deny, name: 'second' }
    expect(computePolicyDigest({ ...config, policies: [deny, other] }))
      .not.toBe(computePolicyDigest({ ...config, policies: [other, deny] }))
    const targets = (values: string[]) => ({ ...config, policies: [{ ...deny, when: { kind: 'any-move-call', targets: values } }] })
    expect(computePolicyDigest(targets(['0x1::m::a', '0x1::m::b'])))
      .not.toBe(computePolicyDigest(targets(['0x1::m::b', '0x1::m::a'])))
    expect(computePolicyDigest(targets(['0x1::m::a'])))
      .not.toBe(computePolicyDigest(targets(['0x1::m::b'])))
    expect(canonicalizeJson('é')).not.toBe(canonicalizeJson('e\u0301'))
  })

  test('rejects values JSON would silently drop, coerce, or execute', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('getter executed') } })
    const hidden = Object.defineProperty({}, 'x', { value: 1 })
    for (const invalid of [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, -Infinity, new Date(), new Map(), new Set(), cyclic, [, 1], [undefined], { x: undefined }, { [Symbol('x')]: 1 }, accessor, hidden, { toJSON() { return 1 } }, Object.assign([1], { extra: 2 })]) {
      expect(() => canonicalizeJson(invalid)).toThrow(/Policy digest/)
    }
    const shared = { x: 1 }
    expect(canonicalizeJson([shared, shared])).toBe('[{"x":1},{"x":1}]')
    expect(canonicalizeJson(JSON.parse('{"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1}}')
  })

  test('validates both the envelope and semantic policy constraints', () => {
    for (const invalid of [{ ...config, version: 2 }, { ...config, extra: 1 }, { policies: [deny] }, { version: 1, policies: [] }, { ...config, policies: [{}] }, { ...config, policies: [deny, deny] }, { ...config, policies: [{ ...deny, when: { kind: 'any-move-call', targets: ['invalid'] } }] }]) {
      expect(() => computePolicyDigest(invalid)).toThrow()
    }
  })
})
