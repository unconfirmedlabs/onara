import { describe, expect, test } from 'bun:test'
import {
  assertGasBudgetWithinCap,
  assertRateLimits,
  GasBudgetExceededError,
  parseGasBudgetMax,
  RateLimitedError,
  type RateLimitBinding,
} from './request-guards'

// ─── parseGasBudgetMax ────────────────────────────────────────────────────────

describe('parseGasBudgetMax', () => {
  test('returns null when unset', () => {
    expect(parseGasBudgetMax(undefined)).toBeNull()
  })

  test('returns null when empty/whitespace', () => {
    expect(parseGasBudgetMax('')).toBeNull()
    expect(parseGasBudgetMax('   ')).toBeNull()
  })

  test('parses a valid decimal string to bigint', () => {
    expect(parseGasBudgetMax('50000000000')).toBe(50_000_000_000n)
  })

  test('trims surrounding whitespace', () => {
    expect(parseGasBudgetMax('  1000  ')).toBe(1_000n)
  })

  test('rejects non-decimal input', () => {
    expect(() => parseGasBudgetMax('abc')).toThrow(/Invalid GAS_BUDGET_MAX/)
    expect(() => parseGasBudgetMax('1.5')).toThrow(/Invalid GAS_BUDGET_MAX/)
    expect(() => parseGasBudgetMax('-100')).toThrow(/Invalid GAS_BUDGET_MAX/)
    expect(() => parseGasBudgetMax('0x10')).toThrow(/Invalid GAS_BUDGET_MAX/)
  })

  test('rejects zero', () => {
    expect(() => parseGasBudgetMax('0')).toThrow(/positive/)
  })
})

// ─── assertGasBudgetWithinCap ─────────────────────────────────────────────────

describe('assertGasBudgetWithinCap', () => {
  test('passes when cap is null (no server cap configured)', () => {
    expect(() => assertGasBudgetWithinCap('999999999999', null)).not.toThrow()
  })

  test('passes when budget is under the cap', () => {
    expect(() => assertGasBudgetWithinCap('1000', 2000n)).not.toThrow()
  })

  test('passes when budget equals the cap', () => {
    expect(() => assertGasBudgetWithinCap('2000', 2000n)).not.toThrow()
  })

  test('rejects when budget exceeds the cap', () => {
    expect(() => assertGasBudgetWithinCap('2001', 2000n)).toThrow(
      GasBudgetExceededError,
    )
  })

  test('accepts number and bigint budget inputs', () => {
    expect(() => assertGasBudgetWithinCap(2001, 2000n)).toThrow(GasBudgetExceededError)
    expect(() => assertGasBudgetWithinCap(2001n, 2000n)).toThrow(GasBudgetExceededError)
  })

  test('treats missing budget as zero', () => {
    expect(() => assertGasBudgetWithinCap(undefined, 2000n)).not.toThrow()
    expect(() => assertGasBudgetWithinCap(null, 2000n)).not.toThrow()
  })
})

// ─── assertRateLimits ─────────────────────────────────────────────────────────

function fakeLimiter(success: boolean): { binding: RateLimitBinding; calls: string[] } {
  const calls: string[] = []
  return {
    binding: {
      limit: async ({ key }) => {
        calls.push(key)
        return { success }
      },
    },
    calls,
  }
}

describe('assertRateLimits', () => {
  test('no-ops when neither binding is present', async () => {
    await expect(
      assertRateLimits({ sender: '0xabc', ip: '1.2.3.4' }),
    ).resolves.toBeUndefined()
  })

  test('passes when both bindings allow', async () => {
    const sender = fakeLimiter(true)
    const ip = fakeLimiter(true)
    await expect(
      assertRateLimits({
        senderLimiter: sender.binding,
        ipLimiter: ip.binding,
        sender: '0xabc',
        ip: '1.2.3.4',
      }),
    ).resolves.toBeUndefined()
    expect(sender.calls).toEqual(['0xabc'])
    expect(ip.calls).toEqual(['1.2.3.4'])
  })

  test('rejects with RateLimitedError(scope: sender) when sender limiter fails', async () => {
    const sender = fakeLimiter(false)
    const ip = fakeLimiter(true)
    const promise = assertRateLimits({
      senderLimiter: sender.binding,
      ipLimiter: ip.binding,
      sender: '0xabc',
      ip: '1.2.3.4',
    })
    await expect(promise).rejects.toBeInstanceOf(RateLimitedError)
    await expect(promise.catch((e) => e.scope)).resolves.toBe('sender')
    // Sender check short-circuits before the IP check.
    expect(ip.calls).toEqual([])
  })

  test('rejects with RateLimitedError(scope: ip) when only the IP limiter fails', async () => {
    const sender = fakeLimiter(true)
    const ip = fakeLimiter(false)
    const promise = assertRateLimits({
      senderLimiter: sender.binding,
      ipLimiter: ip.binding,
      sender: '0xabc',
      ip: '1.2.3.4',
    })
    await expect(promise).rejects.toBeInstanceOf(RateLimitedError)
    await expect(promise.catch((e) => e.scope)).resolves.toBe('ip')
  })

  test('checks only the bindings that are present', async () => {
    const sender = fakeLimiter(true)
    await assertRateLimits({
      senderLimiter: sender.binding,
      sender: '0xabc',
      ip: '1.2.3.4',
    })
    expect(sender.calls).toEqual(['0xabc'])
  })
})
