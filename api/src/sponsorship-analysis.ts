import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Transaction, type TransactionData } from '@mysten/sui/transactions'
import { fromBase64 } from '@mysten/sui/utils'
import pRetry from 'p-retry'

const DEFAULT_SENDER_NAME_TIMEOUT_MS = 5_000

type SimulationResult = Awaited<
  ReturnType<ClientWithCoreApi['core']['simulateTransaction']>
>

/**
 * Immutable, request-scoped facts derived from the exact bytes the sender
 * signed. Data-producing RPC promises are cached for this request; security
 * decisions (signature checks, rate limits, ownership, authorization, signing,
 * and execution) deliberately remain explicit stages in the service.
 */
export class SponsorshipAnalysis {
  readonly bytes: Uint8Array
  readonly data: TransactionData
  readonly gasBudget: number
  readonly moveCallCount: number

  readonly #client: ClientWithCoreApi
  readonly #signal: AbortSignal
  readonly #senderNameTimeoutMs: number
  #currentEpoch?: Promise<bigint>
  #senderName?: Promise<string | null>
  #simulation?: Promise<SimulationResult>

  constructor({
    client,
    txBytesBase64,
    signal,
    senderNameTimeoutMs = DEFAULT_SENDER_NAME_TIMEOUT_MS,
  }: {
    client: ClientWithCoreApi
    txBytesBase64: string
    signal: AbortSignal
    senderNameTimeoutMs?: number
  }) {
    this.#client = client
    this.#signal = signal
    this.#senderNameTimeoutMs = senderNameTimeoutMs
    this.bytes = fromBase64(txBytesBase64)
    this.data = Transaction.from(this.bytes).getData()
    this.gasBudget = Number(this.data.gasData.budget ?? 0)
    this.moveCallCount = this.data.commands.filter(
      (command) => command.$kind === 'MoveCall',
    ).length
  }

  /** Loads and caches the epoch, including the final rejected promise. */
  currentEpoch(): Promise<bigint> {
    if (!this.#currentEpoch) {
      this.#currentEpoch = pRetry(
        () =>
          this.#client.core
            .getCurrentSystemState({ signal: this.#signal })
            .then((state) => BigInt(state.systemState.epoch)),
        { retries: 1, signal: this.#signal },
      )
    }
    return this.#currentEpoch
  }

  /** Resolves the sender's current default SuiNS name only when a branch asks. */
  senderName(): Promise<string | null> {
    if (!this.#senderName) {
      if (!this.data.sender) {
        this.#senderName = Promise.reject(
          new Error('Sponsored transaction is missing its sender.'),
        )
      } else {
        const signal = AbortSignal.any([
          this.#signal,
          AbortSignal.timeout(this.#senderNameTimeoutMs),
        ])
        this.#senderName = pRetry(
          () =>
            this.#client.core
              .defaultNameServiceName({
                address: this.data.sender!,
                signal,
              })
              .then((result) => result.data.name),
          { retries: 1, signal },
        )
      }
    }
    return this.#senderName
  }

  /**
   * Simulates the exact original byte array at most once for this request.
   * FailedTransaction is returned as data; transport/RPC failures reject.
   */
  simulation(): Promise<SimulationResult> {
    if (!this.#simulation) {
      this.#simulation = pRetry(
        () =>
          this.#client.core.simulateTransaction({
            transaction: this.bytes,
            include: { effects: true },
            signal: this.#signal,
          }),
        { retries: 1, signal: this.#signal },
      )
    }
    return this.#simulation
  }
}
