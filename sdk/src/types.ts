// ─── API Responses ───────────────────────────────────────────────────────────

export type StatusResponse = {
  network: string
  chainId: string | null
  address: string
  balances: { active: string; pending: string } | null
}

// ─── Policy Config Types (schema version 1) ──────────────────────────────────

export type PolicyCommandKind =
  | 'MoveCall'
  | 'TransferObjects'
  | 'SplitCoins'
  | 'MergeCoins'
  | 'MakeMoveVec'
  | 'Publish'
  | 'Upgrade'

export type DynamicSenderCheck = {
  kind: 'sender.dynamic'
  url: string
  audience: string
  /** Name of the Worker secret containing the dedicated Bech32 signing key. */
  signingKeyEnv: string
  /** Canonical Sui address derived from the configured signing key. */
  signingIdentity: string
  timeoutMs?: number
  /** Zero disables caching. Positive values must satisfy the server's KV TTL. */
  cacheTtlSeconds?: number
}

export type RequirePolicyConfig = {
  type: 'require'
  name: string
  enabled?: boolean
  check: DynamicSenderCheck
}

export type DenyPolicyWhen =
  | { kind: 'always' }
  | { kind: 'any-move-call'; targets: string[] }
  | { kind: 'sender'; addresses: string[] }

export type DenyPolicyConfig = {
  type: 'deny'
  name: string
  enabled?: boolean
  when: DenyPolicyWhen
}

export type PolicyCallCount =
  | { min?: number; max?: number }
  | { sameAs: string }

export type PolicyCallRule = {
  id: string
  targets: string[]
  count?: PolicyCallCount
  /** Type-argument index to its complete allowed canonical-type set. */
  typeArguments?: Record<string, string[]>
}

export type PolicyOrderingRule = {
  before: string
  after: string
}

export type PolicyResultConsumer = {
  rule: string
  /** Exact zero-based top-level Move-call argument index. */
  argument: number
}

export type PolicyResultFlowRule = {
  /** Exact zero-based result slot on every occurrence of the producer rule. */
  from: { rule: string; result: number }
  to: PolicyResultConsumer[]
  /** Omission means at least one exact allowed use is required. */
  required?: boolean
}

export type PolicyCalls =
  | {
      mode: 'set'
      rules: PolicyCallRule[]
      ordering?: PolicyOrderingRule[]
      resultFlow?: PolicyResultFlowRule[]
    }
  | {
      mode: 'sequence'
      rules: PolicyCallRule[]
      ordering?: never
      resultFlow?: PolicyResultFlowRule[]
    }

export type AllowPolicyConfig = {
  type: 'allow'
  name: string
  enabled?: boolean
  /** Mandatory. An empty array is an explicit public authorization branch. */
  requires: string[]
  senders?: string[]
  suinsNames?: string[]
  /** Positive decimal string in MIST. */
  gasBudgetMax?: string
  commands: {
    allowed: PolicyCommandKind[]
    max?: number
  }
  calls: PolicyCalls
}

export type PolicyConfig =
  | RequirePolicyConfig
  | DenyPolicyConfig
  | AllowPolicyConfig

// ─── Sponsor Types ───────────────────────────────────────────────────────────

export type SponsorOptions = {
  sender: string
  txBytes: string
  txSignature: string
  dryRun?: boolean
  waitForExecution?: boolean
  /**
   * Run pre-flight simulation before execution. Defaults to `true`; pass `false`
   * to skip (e.g. for fire-and-forget paths where the caller has already
   * validated the transaction client-side).
   */
  simulate?: boolean
}

export type SponsorDryRunResponse = {
  dryRun: true
  policy: string
  moveCallTargets: string[]
}

export type SponsorExecutionResponse = Record<string, unknown>

export type SponsorResponse = SponsorDryRunResponse | SponsorExecutionResponse

// ─── Transaction Status Types ───────────────────────────────────────────────

export type TransactionStatusResponse = {
  found: boolean
  digest?: string
  [key: string]: unknown
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export type OnaraErrorResponse = {
  error: string
  digest?: string
  status?: 'unconfirmed' | 'unknown'
}
