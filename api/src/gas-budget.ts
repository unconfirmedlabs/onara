export class GasBudgetExceededError extends Error {}

/**
 * Parses the GAS_BUDGET_MAX env var (a decimal string in MIST). Returns null
 * when unset/empty, meaning "no server-level cap".
 */
export function parseGasBudgetMax(raw: string | undefined): bigint | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `Invalid GAS_BUDGET_MAX: expected a decimal string in MIST, got "${raw}"`,
    )
  }
  const value = BigInt(trimmed)
  if (value <= 0n) {
    throw new Error(`Invalid GAS_BUDGET_MAX: must be a positive integer, got "${raw}"`)
  }
  return value
}

/** Enforces the optional hard server-side gas budget cap. */
export function assertGasBudgetWithinCap(
  budget: string | number | bigint | null | undefined,
  max: bigint | null,
): void {
  if (max === null) return
  const budgetValue = BigInt(budget ?? 0)
  if (budgetValue > max) {
    throw new GasBudgetExceededError(
      `Transaction gas budget (${budgetValue}) exceeds the server maximum (${max}).`,
    )
  }
}
