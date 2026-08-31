import { describe, expect, test } from 'bun:test'
import type { Signer } from '@mysten/sui/cryptography'
import type { SuiGrpcClient } from '@mysten/sui/grpc'
import { executeTransaction } from './execution'

describe('executeTransaction', () => {
  test('signs once and submits the sender and sponsor signatures', async () => {
    let signCount = 0
    let signedBytes: Uint8Array | null = null
    const submittedBytes: number[][] = []
    const submittedSignatures: string[][] = []
    const signer = {
      signTransaction: async (bytes: Uint8Array) => {
        signCount += 1
        signedBytes = bytes
        return { bytes: '', signature: 'sponsor-signature' }
      },
    } as unknown as Signer
    const result = {
      $kind: 'Transaction' as const,
      Transaction: {
        digest: 'digest',
      },
    }
    const client = {
      core: {
        executeTransaction: async ({
          transaction,
          signatures,
        }: {
          transaction: Uint8Array
          signatures: string[]
        }) => {
          submittedBytes.push([...transaction])
          submittedSignatures.push([...signatures])
          if (submittedSignatures.length === 1) {
            throw new Error('transient submission failure')
          }
          return result
        },
      },
    } as unknown as SuiGrpcClient

    const outcome = await executeTransaction({
      grpcClient: client,
      keypair: signer,
      txBytes: new Uint8Array([1, 2, 3]),
      txSignature: 'sender-signature',
      waitForExecution: false,
      executionTimeoutMs: 3_000,
      confirmationTimeoutMs: 1_000,
    })

    expect(outcome.kind).toBe('success')
    expect(signCount).toBe(1)
    expect([...signedBytes!]).toEqual([1, 2, 3])
    expect(submittedBytes).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ])
    expect(submittedSignatures).toEqual([
      ['sender-signature', 'sponsor-signature'],
      ['sender-signature', 'sponsor-signature'],
    ])
  })

  test('does not wait for confirmation when confirmation was not requested', async () => {
    let confirmationCalls = 0
    const signer = {
      signTransaction: async () => ({
        bytes: '',
        signature: 'sponsor-signature',
      }),
    } as unknown as Signer
    const client = {
      core: {
        executeTransaction: async () => ({
          $kind: 'Transaction',
          Transaction: { digest: 'digest' },
        }),
      },
      waitForTransaction: async () => {
        confirmationCalls++
      },
    } as unknown as SuiGrpcClient

    const outcome = await executeTransaction({
      grpcClient: client,
      keypair: signer,
      txBytes: new Uint8Array([1]),
      txSignature: 'sender-signature',
      waitForExecution: false,
      executionTimeoutMs: 1_000,
      confirmationTimeoutMs: 1_000,
    })

    expect(outcome.kind).toBe('success')
    expect(confirmationCalls).toBe(0)
  })

  test('distinguishes an executed chain failure from submission success', async () => {
    const signer = {
      signTransaction: async () => ({
        bytes: '',
        signature: 'sponsor-signature',
      }),
    } as unknown as Signer
    const failed = {
      $kind: 'FailedTransaction' as const,
      FailedTransaction: { digest: 'failed-digest' },
    }
    const client = {
      core: { executeTransaction: async () => failed },
    } as unknown as SuiGrpcClient

    const outcome = await executeTransaction({
      grpcClient: client,
      keypair: signer,
      txBytes: new Uint8Array([1]),
      txSignature: 'sender-signature',
      waitForExecution: false,
      executionTimeoutMs: 1_000,
      confirmationTimeoutMs: 1_000,
    })

    expect(outcome.kind).toBe('chain_failed')
  })

  test('distinguishes confirmation RPC errors from typed timeouts', async () => {
    const signer = {
      signTransaction: async () => ({
        bytes: '',
        signature: 'sponsor-signature',
      }),
    } as unknown as Signer
    const transaction = {
      $kind: 'Transaction' as const,
      Transaction: { digest: 'digest' },
    }
    const base = {
      core: { executeTransaction: async () => transaction },
    }

    const timeout = await executeTransaction({
      grpcClient: {
        ...base,
        waitForTransaction: async () => {
          throw new DOMException('deadline elapsed', 'TimeoutError')
        },
      } as unknown as SuiGrpcClient,
      keypair: signer,
      txBytes: new Uint8Array([1]),
      txSignature: 'sender-signature',
      waitForExecution: true,
      executionTimeoutMs: 1_000,
      confirmationTimeoutMs: 1_000,
    })
    const unavailable = await executeTransaction({
      grpcClient: {
        ...base,
        waitForTransaction: async () => {
          throw new Error('RPC unavailable')
        },
      } as unknown as SuiGrpcClient,
      keypair: signer,
      txBytes: new Uint8Array([1]),
      txSignature: 'sender-signature',
      waitForExecution: true,
      executionTimeoutMs: 1_000,
      confirmationTimeoutMs: 1_000,
    })

    expect(timeout.kind).toBe('confirmation_timeout')
    expect(unavailable.kind).toBe('confirmation_error')
  })

  test('classifies timeouts by type rather than error-message text', async () => {
    const signer = {
      signTransaction: async () => ({
        bytes: '',
        signature: 'sponsor-signature',
      }),
    } as unknown as Signer
    const client = {
      core: {
        executeTransaction: async () => {
          throw new Error('backend says request timed out upstream')
        },
      },
    } as unknown as SuiGrpcClient

    const outcome = await executeTransaction({
      grpcClient: client,
      keypair: signer,
      txBytes: new Uint8Array([1]),
      txSignature: 'sender-signature',
      waitForExecution: false,
      executionTimeoutMs: 3_000,
      confirmationTimeoutMs: 1_000,
    })

    expect(outcome.kind).toBe('execution_error')
  })
})
