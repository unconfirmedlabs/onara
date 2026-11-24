import { bcs } from '@mysten/sui/bcs'
import { type ClientWithCoreApi, ObjectError } from '@mysten/sui/client'
import { parseSerializedSignature } from '@mysten/sui/cryptography'
import { MultiSigPublicKey } from '@mysten/sui/multisig'
import { deriveObjectID, normalizeSuiAddress } from '@mysten/sui/utils'
import {
  isValidTransactionSignature,
  publicKeyFromRawBytes,
} from '@mysten/sui/verify'

export class InvalidSenderSignatureError extends Error {}
export class SenderSignatureVerificationError extends Error {}

/** `0x2::address_alias::AddressAliasState`: the shared parent of every address's alias config. */
const ADDRESS_ALIAS_STATE = '0xa'
const ALIAS_KEY = '0x2::address_alias::AliasKey'

/** `0x2::address_alias::AddressAliases`: `{ id: UID, aliases: VecSet<address> }`. */
const AddressAliases = bcs.struct('AddressAliases', {
  id: bcs.Address,
  aliases: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
})

/** The id of `address`'s alias config: an object derived from `0xa` with the key `AliasKey(address)`. */
export const addressAliasesId = (address: string) =>
  deriveObjectID(
    ADDRESS_ALIAS_STATE,
    ALIAS_KEY,
    bcs.Address.serialize(normalizeSuiAddress(address)).toBytes(),
  )

/**
 * Who may sign for `sender` now: its alias set when it has enabled aliases, or
 * `null` when it hasn't (then only its own key signs for it).
 */
export async function senderAliases(
  client: ClientWithCoreApi,
  sender: string,
): Promise<readonly string[] | null> {
  const [found] = (
    await client.core.getObjects({
      objectIds: [addressAliasesId(sender)],
      include: { content: true },
    })
  ).objects
  if (found instanceof ObjectError && found.reason === 'notFound') return null
  if (found instanceof Error) throw found
  if (!found?.content) throw new Error('The alias config has no content.')
  return AddressAliases.parse(found.content).aliases.contents.map((alias) =>
    normalizeSuiAddress(alias),
  )
}

/** The address a signature was made by, or `null` for a malformed signature. */
function signerOf(signature: string, client: ClientWithCoreApi): string | null {
  try {
    const parsed = parseSerializedSignature(signature)
    const publicKey =
      parsed.signatureScheme === 'MultiSig'
        ? new MultiSigPublicKey(parsed.multisig.multisig_pk)
        : publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey, {
            client,
          })
    return normalizeSuiAddress(publicKey.toSuiAddress())
  } catch {
    return null
  }
}

/**
 * Verify the exact transaction bytes before doing sender-scoped work or asking
 * the sponsor to co-sign. The signer must be allowed to act as the sender, as
 * the chain decides: an address without an alias config signs for itself; one
 * with an alias config (`0x2::address_alias`) is signed for by an address in
 * its alias set, which may no longer include the address itself. Invalid
 * signatures are caller errors; environmental failures (a zkLogin JWK lookup,
 * reading the alias config) remain service errors.
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
  const invalid = () =>
    new InvalidSenderSignatureError(
      'Transaction signature is not valid for the sender.',
    )
  const account = normalizeSuiAddress(sender)
  const signer = signerOf(signature, client)
  if (!signer) throw invalid()

  let valid: boolean
  let aliases: readonly string[] | null
  try {
    ;[valid, aliases] = await Promise.all([
      isValidTransactionSignature(transaction, signature, { client }),
      senderAliases(client, account),
    ])
  } catch (cause) {
    throw new SenderSignatureVerificationError(
      'Unable to verify the sender signature.',
      { cause },
    )
  }

  const allowed =
    aliases === null ? signer === account : aliases.includes(signer)
  if (!valid || !allowed) throw invalid()
}
