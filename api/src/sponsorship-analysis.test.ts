import { describe, expect, test } from 'bun:test'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { SponsorshipAnalysis } from './sponsorship-analysis'

const SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000001'
const SPONSOR =
  '0x0000000000000000000000000000000000000000000000000000000000000002'

async function transactionBytes(): Promise<string> {
  const transaction = new Transaction()
  transaction.setSender(SENDER)
  transaction.setGasOwner(SPONSOR)
  transaction.setGasPayment([])
  transaction.setGasBudget(10_000_000)
  transaction.setGasPrice(1_000)
  transaction.setExpiration({ Epoch: 2 })
  transaction.moveCall({ target: '0x2::coin::zero' })
  return toBase64(await transaction.build())
}

describe('SponsorshipAnalysis', () => {
  test('shares epoch, SuiNS, and simulation facts within one request', async () => {
    let epochCalls = 0
    let nameCalls = 0
    let simulationCalls = 0
    const client = {
      core: {
        getCurrentSystemState: async () => {
          epochCalls++
          return { systemState: { epoch: '1' } }
        },
        defaultNameServiceName: async () => {
          nameCalls++
          return { data: { name: 'alice.sui' } }
        },
        simulateTransaction: async () => {
          simulationCalls++
          return { $kind: 'Transaction', Transaction: {} }
        },
      },
    } as unknown as ClientWithCoreApi
    const analysis = new SponsorshipAnalysis({
      client,
      txBytesBase64: await transactionBytes(),
      signal: new AbortController().signal,
    })

    const [firstEpoch, secondEpoch, firstName, secondName, firstSimulation, secondSimulation] =
      await Promise.all([
        analysis.currentEpoch(),
        analysis.currentEpoch(),
        analysis.senderName(),
        analysis.senderName(),
        analysis.simulation(),
        analysis.simulation(),
      ])

    expect(firstEpoch).toBe(secondEpoch)
    expect(firstName).toBe(secondName)
    expect(firstSimulation).toBe(secondSimulation)
    expect(firstEpoch).toBe(1n)
    expect(firstName).toBe('alice.sui')
    expect(epochCalls).toBe(1)
    expect(nameCalls).toBe(1)
    expect(simulationCalls).toBe(1)
  })

  test('does not resolve SuiNS until a surviving branch asks for it', async () => {
    let nameCalls = 0
    const client = {
      core: {
        getCurrentSystemState: async () => ({
          systemState: { epoch: '1' },
        }),
        defaultNameServiceName: async () => {
          nameCalls++
          return { data: { name: 'alice.sui' } }
        },
      },
    } as unknown as ClientWithCoreApi
    const analysis = new SponsorshipAnalysis({
      client,
      txBytesBase64: await transactionBytes(),
      signal: new AbortController().signal,
    })

    expect(await analysis.currentEpoch()).toBe(1n)
    expect(nameCalls).toBe(0)
    expect(await analysis.senderName()).toBe('alice.sui')
    expect(nameCalls).toBe(1)
  })

  test('caches a rejected resource promise after its internal retry', async () => {
    let epochCalls = 0
    const client = {
      core: {
        getCurrentSystemState: async () => {
          epochCalls++
          throw new Error('RPC unavailable')
        },
      },
    } as unknown as ClientWithCoreApi
    const analysis = new SponsorshipAnalysis({
      client,
      txBytesBase64: await transactionBytes(),
      signal: new AbortController().signal,
    })

    await expect(analysis.currentEpoch()).rejects.toThrow('RPC unavailable')
    await expect(analysis.currentEpoch()).rejects.toThrow('RPC unavailable')
    expect(epochCalls).toBe(2)
  })

  test('aborts a hung resource at the request deadline', async () => {
    const signal = AbortSignal.timeout(25)
    const client = {
      core: {
        getCurrentSystemState: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason)
            } else {
              signal?.addEventListener(
                'abort',
                () => reject(signal.reason),
                { once: true },
              )
            }
          }),
      },
    } as unknown as ClientWithCoreApi
    const analysis = new SponsorshipAnalysis({
      client,
      txBytesBase64: await transactionBytes(),
      signal,
    })

    await expect(analysis.currentEpoch()).rejects.toBeDefined()
  })

  test('bounds SuiNS independently so later branches retain request time', async () => {
    const requestSignal = AbortSignal.timeout(1_000)
    const client = {
      core: {
        defaultNameServiceName: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason)
            } else {
              signal?.addEventListener(
                'abort',
                () => reject(signal.reason),
                { once: true },
              )
            }
          }),
      },
    } as unknown as ClientWithCoreApi
    const analysis = new SponsorshipAnalysis({
      client,
      txBytesBase64: await transactionBytes(),
      signal: requestSignal,
      senderNameTimeoutMs: 25,
    })

    await expect(analysis.senderName()).rejects.toBeDefined()
    expect(requestSignal.aborted).toBe(false)
  })
})
