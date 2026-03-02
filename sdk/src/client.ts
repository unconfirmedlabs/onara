import type { Transaction, BuildTransactionOptions } from '@mysten/sui/transactions'
import type { Signer } from '@mysten/sui/cryptography'
import { toBase64 } from '@mysten/sui/utils'
import { OnaraError } from './errors'
import type {
  StatusResponse,
  PolicyConfig,
  SponsorOptions,
  SponsorResponse,
  OnaraErrorResponse,
} from './types'

export interface OnaraClientOptions {
  url: string
  fetch?: typeof fetch
}

export class OnaraClient {
  private readonly baseUrl: string
  private readonly fetch: typeof fetch

  constructor(options: string | OnaraClientOptions) {
    if (typeof options === 'string') {
      this.baseUrl = options.replace(/\/+$/, '')
      this.fetch = globalThis.fetch
    } else {
      this.baseUrl = options.url.replace(/\/+$/, '')
      this.fetch = options.fetch ?? globalThis.fetch
    }
  }

  async status(): Promise<StatusResponse> {
    const res = await this.fetch(`${this.baseUrl}/status`)
    if (!res.ok) {
      const body = (await res.json()) as OnaraErrorResponse
      throw new OnaraError(body.error, res.status)
    }
    return res.json() as Promise<StatusResponse>
  }

  async policies(): Promise<PolicyConfig[]> {
    const res = await this.fetch(`${this.baseUrl}/policies`)
    if (!res.ok) {
      const body = (await res.json()) as OnaraErrorResponse
      throw new OnaraError(body.error, res.status)
    }
    return res.json() as Promise<PolicyConfig[]>
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
      throw new OnaraError(body.error, res.status)
    }

    return res.json() as Promise<SponsorResponse>
  }

  async sponsorTransaction(options: {
    transaction: Transaction
    signer: Signer
    client: NonNullable<BuildTransactionOptions['client']>
    dryRun?: boolean
    waitForExecution?: boolean
  }): Promise<SponsorResponse> {
    const { transaction, signer, client, dryRun, waitForExecution } = options

    const { address } = await this.status()

    transaction.setSender(signer.toSuiAddress())
    transaction.setGasOwner(address)

    const bytes = await transaction.build({ client })
    const { signature } = await signer.signTransaction(bytes)

    return this.sponsor({
      sender: signer.toSuiAddress(),
      txBytes: toBase64(bytes),
      txSignature: signature,
      dryRun,
      waitForExecution,
    })
  }
}
