export class OnaraError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'OnaraError'
    this.status = status
  }
}
