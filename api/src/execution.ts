import type { SuiGrpcClient } from '@mysten/sui/grpc'
import type { Signer } from '@mysten/sui/cryptography'
import type { SuiClientTypes } from '@mysten/sui/client'
import pTimeout, { TimeoutError } from 'p-timeout'
import pRetry from 'p-retry'

type TransactionResult = SuiClientTypes.TransactionResult<{ effects: true; events: true }>

export type ExecutionOutcome =
  | { kind: 'success'; result: TransactionResult; durationMs: number }
  | { kind: 'chain_failed'; result: TransactionResult; durationMs: number }
  | { kind: 'confirmation_timeout'; result: TransactionResult; digest: string; durationMs: number; error: string }
  | { kind: 'confirmation_error'; result: TransactionResult; digest: string; durationMs: number; error: string }
  | { kind: 'execution_timeout'; durationMs: number; error: string }
  | { kind: 'execution_error'; durationMs: number; error: string }

export interface ExecutionParams {
  grpcClient: SuiGrpcClient
  keypair: Signer
  txBytes: Uint8Array
  txSignature: string
  waitForExecution: boolean
  executionTimeoutMs: number
  confirmationTimeoutMs: number
}

function extractDigest(result: TransactionResult): string {
  return (result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction)?.digest ?? ''
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof TimeoutError ||
    (error instanceof Error && error.name === 'TimeoutError')
  )
}

export async function executeTransaction(params: ExecutionParams): Promise<ExecutionOutcome> {
  const { grpcClient, keypair, txBytes, txSignature, waitForExecution, executionTimeoutMs, confirmationTimeoutMs } = params
  const execStart = Date.now()

  // Phase 1: Sign once, then retry submission with the exact same signature.
  // This keeps retries cheap and remains safe for remote/KMS-backed signers.
  let result: TransactionResult
  try {
    const deadline = Date.now() + executionTimeoutMs
    const { signature: sponsorSignature } = await pTimeout(
      keypair.signTransaction(txBytes),
      {
        milliseconds: executionTimeoutMs,
        message: 'Transaction execution timed out.',
      },
    )
    const remainingMs = Math.max(1, deadline - Date.now())
    const executionAbort = new AbortController()
    try {
      result = await pTimeout(
        pRetry(
          () =>
            grpcClient.core.executeTransaction({
              transaction: txBytes,
              signatures: [txSignature, sponsorSignature],
              include: { effects: true, events: true },
              signal: executionAbort.signal,
            }),
          { retries: 1, signal: executionAbort.signal },
        ),
        {
          milliseconds: remainingMs,
          message: 'Transaction execution timed out.',
        },
      )
    } catch (error) {
      if (error instanceof TimeoutError) executionAbort.abort(error)
      throw error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transaction execution failed.'
    return {
      kind:
        error instanceof TimeoutError
          ? 'execution_timeout'
          : 'execution_error',
      durationMs: Date.now() - execStart,
      error: message,
    }
  }

  // Digest is now captured — safe from confirmation timeout
  const digest = extractDigest(result)
  // Phase 2: Confirmation
  if (waitForExecution) {
    try {
      await grpcClient.waitForTransaction({
        result,
        timeout: confirmationTimeoutMs,
      })
    } catch (error) {
      const timedOut = isTimeoutError(error)
      const message =
        error instanceof Error
          ? error.message
          : timedOut
            ? 'Transaction confirmation timed out.'
            : 'Transaction confirmation failed.'
      return {
        kind: timedOut ? 'confirmation_timeout' : 'confirmation_error',
        result,
        digest,
        durationMs: Date.now() - execStart,
        error: message,
      }
    }
  }

  return {
    kind: result.$kind === 'Transaction' ? 'success' : 'chain_failed',
    result,
    durationMs: Date.now() - execStart,
  }
}
