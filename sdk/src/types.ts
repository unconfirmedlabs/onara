import type { Transaction } from '@mysten/sui/transactions'
import type { Signer as SdkSigner } from '@mysten/sui/cryptography'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import type { Effect } from 'effect'
import type {
  BuildError,
  DecodeError,
  ExecutionFailed,
  JournalError,
  NetworkMismatch,
  NotApplied,
  SimulationFailed,
  SigningError,
  SubmissionUnknown,
  TransportError,
} from '@unconfirmed/sui-effect'
import type { Executed, Recipe } from '@unconfirmed/sui-effect'
import type { Signer as EffectSigner } from '@unconfirmed/sui-effect/tx'
import type { OnaraValidationOnly } from './errors'

// ─── API Responses ───────────────────────────────────────────────────────────

/** The decoded metadata returned by `GET /status`. */
export type StatusResponse = {
  readonly network: string
  readonly chainId: string
  readonly address: string
  readonly balances: {
    readonly active: string
    readonly pending: string
  }
  /** SHA-256 of the server's canonical policy configuration. */
  readonly policyDigest: string
  readonly policyVersion: number
  readonly engineVersion: string
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

export type DenyPolicyWhen =
  | { readonly kind: 'always' }
  | { readonly kind: 'any-move-call'; readonly targets: readonly string[] }
  | { readonly kind: 'sender'; readonly addresses: readonly string[] }

export type DenyPolicyConfig = {
  readonly type: 'deny'
  readonly name: string
  readonly enabled?: boolean
  readonly when: DenyPolicyWhen
}

export type PolicyCallCount =
  | { readonly min?: number; readonly max?: number }
  | { readonly sameAs: string }

export type PolicyCallRule = {
  readonly id: string
  readonly targets: readonly string[]
  readonly count?: PolicyCallCount
  /** Type-argument index to its complete allowed canonical-type set. */
  readonly typeArguments?: Readonly<Record<string, readonly string[]>>
}

export type PolicyOrderingRule = {
  readonly before: string
  readonly after: string
}

export type PolicyResultConsumer = {
  readonly rule: string
  /** Exact zero-based top-level Move-call argument index. */
  readonly argument: number
}

export type PolicyResultFlowRule = {
  /** Exact zero-based result slot on every occurrence of the producer rule. */
  readonly from: { readonly rule: string; readonly result: number }
  readonly to: readonly PolicyResultConsumer[]
  /** Omission means at least one exact allowed use is required. */
  readonly required?: boolean
}

export type PolicyCalls =
  | {
      readonly mode: 'set'
      readonly rules: readonly PolicyCallRule[]
      readonly ordering?: readonly PolicyOrderingRule[]
      readonly resultFlow?: readonly PolicyResultFlowRule[]
    }
  | {
      readonly mode: 'sequence'
      readonly rules: readonly PolicyCallRule[]
      readonly ordering?: never
      readonly resultFlow?: readonly PolicyResultFlowRule[]
    }

export type AllowPolicyConfig = {
  readonly type: 'allow'
  readonly name: string
  readonly enabled?: boolean
  readonly senders?: readonly string[]
  readonly suinsNames?: readonly string[]
  /** Positive decimal string in MIST. */
  readonly gasBudgetMax?: string
  readonly commands: {
    readonly allowed: readonly PolicyCommandKind[]
    readonly max?: number
  }
  readonly calls: PolicyCalls
}

export type PolicyConfig = DenyPolicyConfig | AllowPolicyConfig

// ─── Sponsor Types ───────────────────────────────────────────────────────────

export type SponsorOptions = {
  readonly sender: string
  /** Base64 encoded BCS `TransactionData` bytes. */
  readonly txBytes: string
  /** Base64 encoded sender signature. */
  readonly txSignature: string
  readonly dryRun?: boolean
  readonly waitForExecution?: boolean
  /**
   * @deprecated Onara always runs pre-flight simulation before sponsoring.
   * This option remains for source compatibility and is ignored.
   */
  readonly simulate?: boolean
}

export type SponsorDryRunResponse = {
  readonly dryRun: true
  readonly policy: string
  readonly moveCallTargets: readonly string[]
}

/** A transaction that reached Sui, with decoded effects and execution evidence. */
export type SponsorExecutionResponse = Executed

export type SponsorResponse = SponsorDryRunResponse | SponsorExecutionResponse

export type SponsorTransactionOptions = {
  /** A composable recipe or an SDK transaction whose bytes will be signed once. */
  readonly transaction: Transaction | Recipe
  /** An effect signer, or an existing Mysten SDK signer adapted at the boundary. */
  readonly signer: EffectSigner | SdkSigner
  /** Sui client used to build the transaction; defaults to the registered client. */
  readonly client?: ClientWithCoreApi
  readonly dryRun?: boolean
  readonly waitForExecution?: boolean
  /** @deprecated Onara always simulates before sponsoring; this is ignored. */
  readonly simulate?: boolean
}

export type OnaraRequestError = OnaraErrorResponseError | DecodeError | TransportError

export type OnaraSponsorError =
  | OnaraRequestError
  | NetworkMismatch
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | JournalError

export type OnaraTransactionError =
  | OnaraRequestError
  | NetworkMismatch
  | BuildError
  | SimulationFailed
  | SigningError
  | JournalError
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | OnaraValidationOnly

/** Error response fields accepted from an Onara HTTP endpoint. */
export type OnaraErrorResponse = {
  readonly error: string
  readonly digest?: string
  /** Legacy submit status retained for consumers migrating from 0.2.x. */
  readonly status?: 'unconfirmed' | 'unknown'
  readonly txStatus?: 'unconfirmed' | 'unknown'
  readonly outcome?: 'not_applied' | 'unknown' | 'applied'
}

/** The SDK's tagged HTTP-domain error, exported from `errors.ts`. */
export type OnaraErrorResponseError = import('./errors').OnaraError

/** Public Effect service shape. */
export interface OnaraService {
  /** Read sponsor metadata. Fails with `OnaraError`, `DecodeError`, `TransportError`. */
  readonly status: Effect.Effect<StatusResponse, OnaraRequestError>
  /**
   * Submit exact pre-built bytes. Fails with `OnaraError`, `DecodeError`,
   * `TransportError`, `NetworkMismatch`, `ExecutionFailed`, `NotApplied`,
   * `SubmissionUnknown`, and transaction lifecycle errors.
   */
  readonly sponsor: (
    options: SponsorOptions,
  ) => Effect.Effect<SponsorResponse, OnaraSponsorError>
  /**
   * Build and sign a recipe or transaction, then submit it through Onara.
   * Fails with the same closed union as `sponsor`, plus `BuildError`,
   * `SimulationFailed`, `SigningError`, and `JournalError`.
   */
  readonly sponsorTransaction: (
    options: SponsorTransactionOptions,
  ) => Effect.Effect<SponsorResponse, OnaraTransactionError>
  /**
   * Recover a transaction status. A 404 is a typed `found:false` result only
   * when the endpoint explicitly returns that not-found response; other
   * failures propagate `OnaraError`, `DecodeError`, or `TransportError`.
   */
  readonly getTransactionStatus: (
    digest: string,
  ) => Effect.Effect<TransactionStatusResponse, OnaraRequestError>
}

export type TransactionStatusResponse =
  | { readonly found: false; readonly digest: string }
  | { readonly found: true; readonly digest: string; readonly result: Executed }
  | { readonly found: true; readonly digest: string; readonly failure: ExecutionFailed }
