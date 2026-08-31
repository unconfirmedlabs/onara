import type { ClientWithCoreApi } from '@mysten/sui/client'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { isValidTransactionSignature } from '@mysten/sui/verify'

export class InvalidSenderSignatureError extends Error {}
export class SenderSignatureVerificationError extends Error {}

/**
 * Verify the exact transaction bytes before doing sender-scoped work or asking
 * the sponsor to co-sign. Invalid signatures are caller errors; environmental
 * failures (for example a zkLogin JWK lookup failure) remain service errors.
 */
export async function assertValidSenderSignature({
  client,
  sender,
  transaction,
  signature,
}: {
  client: ClientWithCoreApi
  sender: string
  transaction: Uint8Array
  signature: string
}): Promise<void> {
  let valid: boolean
  try {
    valid = await isValidTransactionSignature(transaction, signature, {
      address: normalizeSuiAddress(sender),
      client,
    })
  } catch (cause) {
    throw new SenderSignatureVerificationError(
      'Unable to verify the sender signature.',
      { cause },
    )
  }

  if (!valid) {
    throw new InvalidSenderSignatureError(
      'Transaction signature is not valid for the sender.',
    )
  }
}
