import { describe, expect, test } from 'bun:test'
import {
  assertGasBudgetWithinCap,
  GasBudgetExceededError,
  parseGasBudgetMax,
} from './gas-budget'

describe('parseGasBudgetMax', () => {
  test('returns null when unset or empty', () => {
    expect(parseGasBudgetMax(undefined)).toBeNull()
    expect(parseGasBudgetMax('  ')).toBeNull()
  })

  test('parses a positive decimal string', () => {
    expect(parseGasBudgetMax(' 50000000 ')).toBe(50000000n)
  })

  test('rejects non-decimal or non-positive input', () => {
    for (const value of ['x', '1.5', '-1', '0']) {
      expect(() => parseGasBudgetMax(value)).toThrow(/GAS_BUDGET_MAX/)
    }
  })
})

describe('assertGasBudgetWithinCap', () => {
  test('allows budgets at or below the configured cap', () => {
    expect(() => assertGasBudgetWithinCap(10, 10n)).not.toThrow()
    expect(() => assertGasBudgetWithinCap(undefined, 10n)).not.toThrow()
  })

  test('rejects a budget above the configured cap', () => {
    expect(() => assertGasBudgetWithinCap(11, 10n)).toThrow(
      GasBudgetExceededError,
    )
  })
})
