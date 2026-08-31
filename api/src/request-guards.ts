// Server-level request guards for sponsorship: a hard cap on gas budget and
// optional Workers Rate Limiting bindings, both enforced before policy
// matching / simulation / signing.

export class GasBudgetExceededError extends Error {}
export class RateLimitedError extends Error {
  readonly scope: 'sender' | 'ip'
  constructor(message: string, scope: 'sender' | 'ip') {
    super(message)
    this.scope = scope
  }
}

/**
 * Cloudflare Workers Rate Limiting binding shape.
 * `@cloudflare/workers-types` isn't a dependency here, so this is typed by hand.
 */
export type RateLimitBinding = {
  limit(options: { key: string }): Promise<{ success: boolean }>
}

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

/**
 * Enforces the server-level gas budget cap, if configured. Must run before
 * policy matching — a policy's own `gasBudgetMax` is a soft-skip, not a hard
 * server limit.
 */
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

/**
 * Checks the optional per-sender and per-IP rate limit bindings. Either or
 * both may be absent, in which case that dimension isn't limited. Must run
 * before simulation/signing so abusive callers are rejected cheaply.
 */
export async function assertRateLimits({
  senderLimiter,
  ipLimiter,
  sender,
  ip,
}: {
  senderLimiter?: RateLimitBinding
  ipLimiter?: RateLimitBinding
  sender: string
  ip: string
}): Promise<void> {
  if (senderLimiter) {
    const result = await senderLimiter.limit({ key: sender })
    if (!result.success) {
      throw new RateLimitedError(
        `Rate limit exceeded for sender ${sender}.`,
        'sender',
      )
    }
  }
  if (ipLimiter) {
    const result = await ipLimiter.limit({ key: ip })
    if (!result.success) {
      throw new RateLimitedError('Rate limit exceeded for this IP address.', 'ip')
    }
  }
}
