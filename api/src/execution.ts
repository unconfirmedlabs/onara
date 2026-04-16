import type { SuiGrpcClient } from '@mysten/sui/grpc'
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import type { SuiClientTypes } from '@mysten/sui/client'
import pTimeout from 'p-timeout'
import pRetry from 'p-retry'

type TransactionResult = SuiClientTypes.TransactionResult<{ effects: true }>

export type SponsorEventStatus =
  | 'received'
  | 'validating'
  | 'simulating'
  | 'signing'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'error'

export interface SponsorEvent {
  status: SponsorEventStatus
  digest?: string
  result?: unknown
  error?: string
}

export type OnStatus = (event: SponsorEvent) => void

export type ExecutionOutcome =
  | { kind: 'success'; result: TransactionResult; durationMs: number }
  | { kind: 'confirmation_timeout'; result: TransactionResult; digest: string; durationMs: number; error: string }
  | { kind: 'execution_timeout'; durationMs: number; error: string }
  | { kind: 'execution_error'; durationMs: number; error: string }

export interface ExecutionParams {
  grpcClient: SuiGrpcClient
  keypair: Ed25519Keypair
  txBytes: Uint8Array
  txSignature: string
  waitForExecution: boolean
  executionTimeoutMs: number
  confirmationTimeoutMs: number
  onStatus?: OnStatus
}

function extractDigest(result: TransactionResult): string {
  return (result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction)?.digest ?? ''
}

export async function executeTransaction(params: ExecutionParams): Promise<ExecutionOutcome> {
  const { grpcClient, keypair, txBytes, txSignature, waitForExecution, executionTimeoutMs, confirmationTimeoutMs, onStatus } = params
  const execStart = Date.now()

  // Phase 1: Sign and execute
  let result: TransactionResult
  onStatus?.({ status: 'signing' })
  try {
    result = await pTimeout(
      pRetry(
        () => grpcClient.signAndExecuteTransaction({
          signer: keypair,
          transaction: txBytes,
          additionalSignatures: [txSignature],
          include: { effects: true },
        }),
        { retries: 1 },
      ),
      { milliseconds: executionTimeoutMs, message: 'Transaction execution timed out.' },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transaction execution failed.'
    return { kind: message.includes('timed out') ? 'execution_timeout' : 'execution_error', durationMs: Date.now() - execStart, error: message }
  }

  // Digest is now captured — safe from confirmation timeout
  const digest = extractDigest(result)
  onStatus?.({ status: 'submitted', digest })

  // Phase 2: Confirmation
  if (waitForExecution) {
    onStatus?.({ status: 'confirming' })
    try {
      await pTimeout(
        grpcClient.waitForTransaction({ result }),
        { milliseconds: confirmationTimeoutMs, message: 'Transaction confirmation timed out.' },
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Transaction confirmation timed out.'
      return { kind: 'confirmation_timeout', result, digest, durationMs: Date.now() - execStart, error: message }
    }
  }

  onStatus?.({ status: 'confirmed', digest, result })
  return { kind: 'success', result, durationMs: Date.now() - execStart }
}
