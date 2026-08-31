import type { Transaction } from '@mysten/sui/transactions'
import type { Signer } from '@mysten/sui/cryptography'
import type { ClientWithCoreApi, SuiClientRegistration } from '@mysten/sui/client'
import { toBase64 } from '@mysten/sui/utils'
import { OnaraError } from './errors'
import type {
  StatusResponse,
  SponsorOptions,
  SponsorResponse,
  TransactionStatusResponse,
  OnaraErrorResponse,
} from './types'

export interface OnaraClientOptions {
  url: string
  /** Custom `fetch` implementation (e.g. for testing or a service binding). */
  fetch?: typeof fetch
  /**
   * Optional Sui client used by the `sponsorTransaction*` helpers to build
   * transactions. Set automatically when the SDK is registered via {@link onara}.
   */
  client?: ClientWithCoreApi
}

export class OnaraClient {
  private readonly baseUrl: string
  private readonly fetch: typeof fetch
  private readonly suiClient?: ClientWithCoreApi

  constructor(options: string | OnaraClientOptions) {
    if (typeof options === 'string') {
      this.baseUrl = options.replace(/\/+$/, '')
      this.fetch = globalThis.fetch
    } else {
      this.baseUrl = options.url.replace(/\/+$/, '')
      this.fetch = options.fetch ?? globalThis.fetch
      this.suiClient = options.client
    }
  }

  private resolveClient(client?: ClientWithCoreApi): ClientWithCoreApi {
    const resolved = client ?? this.suiClient
    if (!resolved) {
      throw new OnaraError(
        'A Sui client is required to build the transaction. Pass `client`, set it in the constructor options, or register the SDK with `client.$extend(onara({ url }))`.',
        0,
      )
    }
    return resolved
  }

  async status(): Promise<StatusResponse> {
    const res = await this.fetch(`${this.baseUrl}/status`)
    if (!res.ok) {
      const body = (await res.json()) as OnaraErrorResponse
      throw new OnaraError(body.error, res.status)
    }
    return res.json() as Promise<StatusResponse>
  }

  async sponsor(options: SponsorOptions): Promise<SponsorResponse> {
    const params = new URLSearchParams()
    if (options.dryRun) params.set('dryRun', 'true')
    if (options.waitForExecution === false) params.set('waitForExecution', 'false')

    const query = params.toString()
    const url = `${this.baseUrl}/sponsor${query ? `?${query}` : ''}`

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: options.sender,
        txBytes: options.txBytes,
        txSignature: options.txSignature,
      }),
    })

    if (!res.ok) {
      const body = (await res.json()) as OnaraErrorResponse
      throw new OnaraError(body.error, res.status, {
        digest: body.digest,
        txStatus: body.status,
      })
    }

    return res.json() as Promise<SponsorResponse>
  }

  async sponsorTransaction(options: {
    transaction: Transaction
    signer: Signer
    /** Sui client used to build the transaction. Defaults to the client the SDK was registered/constructed with. */
    client?: ClientWithCoreApi
    dryRun?: boolean
    waitForExecution?: boolean
    /** @deprecated Onara always simulates before sponsoring. This option is ignored. */
    simulate?: boolean
  }): Promise<SponsorResponse> {
    const { transaction, signer, dryRun, waitForExecution } = options
    const client = this.resolveClient(options.client)
    const sender = signer.toSuiAddress()

    const { address } = await this.status()

    transaction.setSender(sender)
    transaction.setGasOwner(address)
    // Onara sponsors exclusively from the sponsor's address balance. Setting an
    // explicit empty payment prevents the Sui resolver from falling back to
    // sponsor-owned coin objects when that balance is insufficient.
    transaction.setGasPayment([])

    const bytes = await transaction.build({ client })
    const { signature } = await signer.signTransaction(bytes)

    return this.sponsor({
      sender,
      txBytes: toBase64(bytes),
      txSignature: signature,
      dryRun,
      waitForExecution,
    })
  }

  // ─── Transaction status lookup ────────────────────────────────────────────

  /**
   * Look up the on-chain status of a sponsored transaction by digest. Useful for
   * recovering after a confirmation timeout, where {@link OnaraClient.sponsor}
   * surfaces a digest with `txStatus: 'unconfirmed'` on the thrown error.
   */
  async getTransactionStatus(digest: string): Promise<TransactionStatusResponse> {
    const res = await this.fetch(`${this.baseUrl}/sponsor/${digest}/status`)
    return res.json() as Promise<TransactionStatusResponse>
  }
}

export interface OnaraExtensionOptions<Name extends string = 'onara'> {
  url: string
  /** Property name the client is registered under. Defaults to `'onara'`. */
  name?: Name
  /** Custom `fetch` implementation (e.g. for testing or a service binding). */
  fetch?: typeof fetch
}

/**
 * Register Onara as an extension on a Sui client, following the Mysten SDK
 * extension pattern:
 *
 * ```ts
 * const client = new SuiClient({ network: 'testnet' })
 *   .$extend(onara({ url: 'https://my-onara.example.com' }))
 *
 * await client.onara.sponsorTransaction({ transaction, signer })
 * ```
 *
 * The registered client is reused as the default for the `sponsorTransaction*`
 * helpers, so it no longer needs to be passed explicitly.
 */
export function onara<const Name extends string = 'onara'>({
  name = 'onara' as Name,
  ...options
}: OnaraExtensionOptions<Name>): SuiClientRegistration<ClientWithCoreApi, Name, OnaraClient> {
  return {
    name,
    register: (client) => new OnaraClient({ ...options, client }),
  }
}
