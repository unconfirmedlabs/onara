import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { parseOnaraConfig } from './config'
import { loadPolicies } from '../policy'

/**
 * Canonical JSON: UTF-16 lexicographic object keys, original array order, and
 * JSON.stringify primitive encoding. Serialize keys directly: rebuilding an
 * object would cause JavaScript to reorder integer-like keys numerically.
 */
export function canonicalizeJson(input: unknown): string {
  const ancestors = new Set<object>()
  function serialize(value: unknown): string {
    if (value === null) return 'null'
    if (typeof value === 'string' || typeof value === 'boolean') {
      return JSON.stringify(value)
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return JSON.stringify(value)
    }
    if (typeof value !== 'object') {
      throw new Error('Policy digest requires JSON values (finite numbers only).')
    }
    if (ancestors.has(value)) throw new Error('Policy digest rejects cyclic JSON.')
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) {
      throw new Error('Policy digest requires plain JSON objects.')
    }
    if (Object.getOwnPropertySymbols(value).length) {
      throw new Error('Policy digest rejects symbol keys.')
    }
    ancestors.add(value)
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const read = (key: string): unknown => {
        const descriptor = descriptors[key]
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Policy digest rejects sparse arrays and non-JSON properties.')
        }
        return descriptor.value
      }
      if (Array.isArray(value)) {
        if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
          throw new Error('Policy digest rejects sparse arrays and extra array properties.')
        }
        return `[${Array.from({ length: value.length }, (_, i) => serialize(read(String(i)))).join(',')}]`
      }
      return `{${Object.keys(descriptors).sort().map((key) => `${JSON.stringify(key)}:${serialize(read(key))}`).join(',')}}`
    } finally {
      ancestors.delete(value)
    }
  }
  return serialize(input)
}

/** Validate and retain the supplied JSON, before compiler defaults/normalization. */
export function loadPolicyConfig(input: unknown) {
  const canonical = canonicalizeJson(input)
  // A private snapshot prevents caller mutation from changing the configuration
  // associated with the digest. Compilation operates on this same snapshot.
  const config = parseOnaraConfig(JSON.parse(canonical))
  const policies = loadPolicies(config.policies)
  freezeJson(config)
  return {
    config,
    policies,
    policyVersion: config.version,
    policyDigest: `sha256:${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`,
  }
}

export function computePolicyDigest(config: unknown): string {
  return loadPolicyConfig(config).policyDigest
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeJson(child)
  Object.freeze(value)
}
