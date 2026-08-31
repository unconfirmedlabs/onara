import type { Keypair } from '@mysten/sui/cryptography'
import type { SuiGrpcClient } from '@mysten/sui/grpc'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import pTimeout, { TimeoutError } from 'p-timeout'
import {
  selectPolicyAllowBranch,
  validateSponsoredTransactionData,
  type CompiledPolicies,
  type PolicyEvaluationPlan,
} from './policy'
import {
  assertSenderControlsOwnedInputs,
  OwnedInputAuthorizationError,
} from './input-authorization'
import {
  assertValidSenderSignature,
  InvalidSenderSignatureError,
} from './sender-signature'
import {
  executeTransaction,
  type ExecutionOutcome,
} from './execution'
import {
  assertGasBudgetWithinCap,
  GasBudgetExceededError,
} from './gas-budget'
import { SponsorshipAnalysis } from './sponsorship-analysis'

export type SponsorshipMode = 'validate-only' | 'execute'

export type SponsorshipStage =
  | 'guard'
  | 'signature'
  | 'context'
  | 'policy'
  | 'ownership'
  | 'suins'
  | 'simulation'
  | 'execution'

export type SponsorshipStageObserver = (
  stage: SponsorshipStage,
  phase: 'start' | 'end',
) => void

export type SponsorshipFailureKind =
  | 'invalid-transaction'
  | 'policy-denied'
  | 'request-timeout'
  | 'invalid-signature'
  | 'signature-unavailable'
  | 'context-unavailable'
  | 'input-not-authorized'
  | 'input-lookup-unavailable'
  | 'suins-unavailable'
  | 'simulation-failed'
  | 'simulation-unavailable'

export class SponsorshipFailure extends Error {
  readonly kind: SponsorshipFailureKind

  constructor(
    kind: SponsorshipFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.kind = kind
  }
}

export function sponsorshipHttpStatus(
  failure: SponsorshipFailure,
): 400 | 403 | 429 | 503 | 504 {
  switch (failure.kind) {
    case 'request-timeout':
      return 504
    case 'policy-denied':
      return 403
    case 'signature-unavailable':
    case 'context-unavailable':
    case 'input-lookup-unavailable':
    case 'suins-unavailable':
    case 'simulation-unavailable':
      return 503
    default:
      return 400
  }
}

export type SponsorshipPayload = {
  sender: string
  txBytes: string
  txSignature: string
}

export type SponsorshipRequest = {
  payload: SponsorshipPayload
  mode: SponsorshipMode
  waitForExecution: boolean
  executionTimeoutMs: number
  confirmationTimeoutMs: number
}

export type SponsorshipDependencies = {
  client: SuiGrpcClient
  keypair: Keypair
  sponsorAddress: string
  policies: CompiledPolicies
  gasBudgetMax: bigint | null
  forceValidateOnly: boolean
}

export type SponsorshipMetadata = {
  sender: string
  policyName: string
  moveCallTargets: string[]
  gasBudget: number
  moveCallCount: number
}

export type SponsorshipResult =
  | {
      kind: 'validated'
      metadata: SponsorshipMetadata
    }
  | {
      kind: 'executed'
      metadata: SponsorshipMetadata
      outcome: ExecutionOutcome
    }

async function runStage<T>(
  stage: SponsorshipStage,
  observer: SponsorshipStageObserver | undefined,
  operation: () => Promise<T> | T,
  deadlineAt?: number,
): Promise<T> {
  notifyStage(observer, stage, 'start')
  try {
    if (deadlineAt === undefined) return await operation()
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) {
      throw failure('request-timeout', 'Sponsorship request timed out.')
    }
    try {
      return await pTimeout(Promise.resolve().then(operation), {
        milliseconds: remainingMs,
        message: 'Sponsorship request timed out.',
      })
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw failure('request-timeout', error.message, error)
      }
      throw error
    }
  } finally {
    notifyStage(observer, stage, 'end')
  }
}

function notifyStage(
  observer: SponsorshipStageObserver | undefined,
  stage: SponsorshipStage,
  phase: 'start' | 'end',
): void {
  try {
    observer?.(stage, phase)
  } catch (error) {
    console.error(
      JSON.stringify({
        message: 'Sponsorship stage observer failed.',
        stage,
        phase,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
}

function failure(
  kind: SponsorshipFailureKind,
  message: string,
  cause?: unknown,
): SponsorshipFailure {
  return new SponsorshipFailure(kind, message, { cause })
}

function simulationErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error) return error
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'unknown error'
}

/**
 * One sponsorship pipeline shared by every HTTP execution mode, so dry-run and
 * executable requests cannot reorder or omit security stages.
 */
export async function sponsorRequest({
  request,
  dependencies,
  onStage,
}: {
  request: SponsorshipRequest
  dependencies: SponsorshipDependencies
  onStage?: SponsorshipStageObserver
}): Promise<SponsorshipResult> {
  const timeoutMs = Math.max(1, request.executionTimeoutMs)
  const deadlineAt = Date.now() + timeoutMs
  const signal = AbortSignal.timeout(timeoutMs)
  const stage = <T>(
    name: SponsorshipStage,
    operation: () => Promise<T> | T,
  ) => runStage(name, onStage, operation, deadlineAt)

  const { analysis, sender } = await stage('guard', async () => {
    try {
      const analysis = new SponsorshipAnalysis({
        client: dependencies.client,
        txBytesBase64: request.payload.txBytes,
        signal,
      })
      if (!analysis.data.sender) {
        throw new Error('Sponsored transaction is missing its sender.')
      }
      const sender = normalizeSuiAddress(analysis.data.sender)
      if (sender !== normalizeSuiAddress(request.payload.sender)) {
        throw new Error('Transaction sender does not match payload sender.')
      }
      assertGasBudgetWithinCap(
        analysis.data.gasData.budget,
        dependencies.gasBudgetMax,
      )
      return { analysis, sender }
    } catch (error) {
      if (error instanceof GasBudgetExceededError) {
        throw failure('invalid-transaction', error.message, error)
      }
      throw failure(
        'invalid-transaction',
        error instanceof Error
          ? error.message
          : 'Unable to parse sponsored transaction.',
        error,
      )
    }
  })

  await stage('signature', async () => {
    try {
      await assertValidSenderSignature({
        client: dependencies.client,
        sender,
        transaction: analysis.bytes,
        signature: request.payload.txSignature,
      })
    } catch (error) {
      if (error instanceof InvalidSenderSignatureError) {
        throw failure('invalid-signature', error.message, error)
      }
      throw failure(
        'signature-unavailable',
        'Unable to verify the sender signature.',
        error,
      )
    }
  })

  const currentEpoch = await stage('context', async () => {
    try {
      return await analysis.currentEpoch()
    } catch (error) {
      if (signal.aborted) {
        throw failure('request-timeout', 'Sponsorship request timed out.', error)
      }
      throw failure(
        'context-unavailable',
        'Unable to resolve transaction policy context.',
        error,
      )
    }
  })

  const plan = await stage('policy', async () => {
    try {
      return validateSponsoredTransactionData({
        txData: analysis.data,
        expectedSender: sender,
        expectedSponsor: dependencies.sponsorAddress,
        currentEpoch,
        policies: dependencies.policies,
        deferSuinsNameResolution: true,
      })
    } catch (error) {
      console.warn(
        JSON.stringify({
          message: 'Sponsorship policy rejected transaction.',
          sender,
          error:
            error instanceof Error
              ? error.message
              : 'Unable to validate sponsored transaction.',
        }),
      )
      throw failure(
        'policy-denied',
        'Transaction is not eligible for sponsorship.',
        error,
      )
    }
  })

  await stage('ownership', async () => {
    try {
      await assertSenderControlsOwnedInputs({
        client: dependencies.client,
        sender,
        objectIds: plan.ownedInputIds,
        signal,
      })
    } catch (error) {
      if (error instanceof OwnedInputAuthorizationError) {
        throw failure('input-not-authorized', error.message, error)
      }
      if (signal.aborted) {
        throw failure('request-timeout', 'Sponsorship request timed out.', error)
      }
      throw failure(
        'input-lookup-unavailable',
        'Unable to verify sponsored transaction object ownership.',
        error,
      )
    }
  })

  const selection = await stage('suins', () =>
    selectPolicyAllowBranch({
      allowBranches: plan.allowBranches,
      resolveSenderName: () => analysis.senderName(),
    }),
  )
  if (signal.aborted) {
    throw failure('request-timeout', 'Sponsorship request timed out.')
  }
  if (selection.status === 'denied') {
    throw failure(
      'policy-denied',
      'Transaction is not eligible for sponsorship.',
    )
  }
  if (selection.status === 'unavailable') {
    throw failure(
      'suins-unavailable',
      'Unable to resolve SuiNS policy context.',
    )
  }

  const metadata: SponsorshipMetadata = {
    sender,
    policyName: selection.policyName,
    moveCallTargets: plan.calledTargets,
    gasBudget: analysis.gasBudget,
    moveCallCount: analysis.moveCallCount,
  }

  console.log(
    JSON.stringify({
      message: 'Sponsor request validated.',
      sender,
      sponsor: dependencies.sponsorAddress,
      policy: metadata.policyName,
      moveCallTargets: metadata.moveCallTargets,
    }),
  )

  if (
    dependencies.forceValidateOnly ||
    request.mode === 'validate-only'
  ) {
    return { kind: 'validated', metadata }
  }

  await stage('simulation', async () => {
    let simulation: Awaited<ReturnType<SponsorshipAnalysis['simulation']>>
    try {
      simulation = await analysis.simulation()
    } catch (error) {
      if (signal.aborted) {
        throw failure('request-timeout', 'Sponsorship request timed out.', error)
      }
      throw failure(
        'simulation-unavailable',
        'Unable to simulate sponsored transaction.',
        error,
      )
    }
    if (simulation.$kind === 'FailedTransaction') {
      throw failure(
        'simulation-failed',
        `Simulation failed: ${simulationErrorMessage(
          simulation.FailedTransaction.status.error,
        )}`,
      )
    }
  })

  if (signal.aborted || deadlineAt <= Date.now()) {
    throw failure('request-timeout', 'Sponsorship request timed out.')
  }
  const remainingExecutionMs = deadlineAt - Date.now()
  const outcome = await runStage('execution', onStage, () =>
    executeTransaction({
      grpcClient: dependencies.client,
      keypair: dependencies.keypair,
      txBytes: analysis.bytes,
      txSignature: request.payload.txSignature,
      waitForExecution: request.waitForExecution,
      executionTimeoutMs: remainingExecutionMs,
      confirmationTimeoutMs: request.confirmationTimeoutMs,
    }),
  )

  return { kind: 'executed', metadata, outcome }
}
