// ─── API Responses ───────────────────────────────────────────────────────────

export type StatusResponse = {
  network: string
  chainId: string | null
  address: string
  balances: { active: string; pending: string } | null
}

// ─── Policy Config Types ─────────────────────────────────────────────────────

export type PolicyCallLimitRange = {
  min?: number
  max?: number
}

export type PolicyCallLimitCountMatch = {
  countMatch: string
}

export type PolicyCallLimit = PolicyCallLimitRange | PolicyCallLimitCountMatch

export type PolicyOrderingRule = {
  before: string
  after: string
}

export type PolicyResultFlowRule = {
  from: string
  to: string[]
  required?: boolean
}

export type PolicySequenceStep = {
  id: string
  targets: string[]
  count?: number
  min?: number
  max?: number
}

export type PolicyConfig = {
  name: string
  enabled?: boolean
  senders?: string[]
  gasBudgetMax?: number
  targets?: string[]
  sequence?: PolicySequenceStep[]
  callLimits?: Record<string, PolicyCallLimit>
  ordering?: PolicyOrderingRule[]
  resultFlow?: PolicyResultFlowRule[]
  typeArguments?: Record<string, Record<string, string[]>>
  maxCommands?: number
  allowedCommandKinds?: string[]
}

// ─── Sponsor Types ───────────────────────────────────────────────────────────

export type SponsorOptions = {
  sender: string
  txBytes: string
  txSignature: string
  dryRun?: boolean
  waitForExecution?: boolean
}

export type SponsorDryRunResponse = {
  dryRun: true
  policy: string
  moveCallTargets: string[]
}

export type SponsorExecutionResponse = Record<string, unknown>

export type SponsorResponse = SponsorDryRunResponse | SponsorExecutionResponse

// ─── Error Types ─────────────────────────────────────────────────────────────

export type OnaraErrorResponse = {
  error: string
}
