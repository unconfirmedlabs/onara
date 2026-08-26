export class OnaraError extends Error {
  status: number
  digest?: string
  txStatus?: 'unconfirmed' | 'unknown'

  constructor(message: string, status: number, options?: { digest?: string; txStatus?: string }) {
    super(message)
    this.name = 'OnaraError'
    this.status = status
    this.digest = options?.digest
    this.txStatus = options?.txStatus as 'unconfirmed' | 'unknown' | undefined
  }
}
