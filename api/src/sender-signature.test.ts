import { describe, expect, test } from 'bun:test'
import { bcs } from '@mysten/sui/bcs'
import { type ClientWithCoreApi, ObjectError } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  addressAliasesId,
  assertValidSenderSignature,
  InvalidSenderSignatureError,
  SenderSignatureVerificationError,
} from './sender-signature'

const SPONSOR = normalizeSuiAddress('0x2')
const CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'

/**
 * A client whose chain holds these alias configs (sender → alias set); any
 * other address has none. `failing` makes every read fail.
 */
function chain(
  configs: Record<string, readonly string[]> = {},
  failing = false,
): ClientWithCoreApi {
  const byId = new Map(
    Object.entries(configs).map(([address, aliases]) => {
      const id = addressAliasesId(address)
      const content = bcs
        .struct('AddressAliases', {
          id: bcs.Address,
          aliases: bcs.struct('VecSet', { contents: bcs.vector(bcs.Address) }),
        })
        .serialize({ id, aliases: { contents: [...aliases] } })
        .toBytes()
      return [id, content] as const
    }),
  )
  return {
    core: {
      getObjects: async ({ objectIds }: { objectIds: string[] }) => {
        if (failing) throw new Error('node unreachable')
        return {
          objects: objectIds.map((id) => {
            const content = byId.get(id)
            return content
              ? { objectId: id, content }
              : new ObjectError('notFound', `Object ${id} not found`, {
                  reason: 'notFound',
                  objectId: id,
                })
          }),
        }
      },
    },
  } as unknown as ClientWithCoreApi
}

async function signedTransaction(signer: Ed25519Keypair, sender = signer.toSuiAddress()) {
  const transaction = new Transaction()
  transaction.setSender(sender)
  transaction.setGasOwner(SPONSOR)
  transaction.setGasPayment([])
  transaction.setGasBudget(10_000_000)
  transaction.setGasPrice(1_000)
  transaction.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 1,
    },
  })
  transaction.moveCall({
    target: '0x2::coin::zero',
    typeArguments: ['0x2::sui::SUI'],
  })
  const bytes = await transaction.build()
  const { signature } = await signer.signTransaction(bytes)
  return { bytes, signature }
}

describe('assertValidSenderSignature', () => {
  test('accepts a valid signature from the transaction sender', async () => {
    const signer = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(signer)

    await expect(
      assertValidSenderSignature({
        client: chain(),
        sender: signer.toSuiAddress(),
        transaction: bytes,
        signature,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects a signature from a different address', async () => {
    const signer = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(signer)

    await expect(
      assertValidSenderSignature({
        client: chain(),
        sender: new Ed25519Keypair().toSuiAddress(),
        transaction: bytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(InvalidSenderSignatureError)
  })

  test('rejects a signature over different transaction bytes', async () => {
    const signer = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(signer)
    const changedBytes = bytes.slice()
    changedBytes[changedBytes.length - 1] ^= 1

    await expect(
      assertValidSenderSignature({
        client: chain(),
        sender: signer.toSuiAddress(),
        transaction: changedBytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(InvalidSenderSignatureError)
  })

  test('accepts a signature from an alias of the sender', async () => {
    const account = new Ed25519Keypair().toSuiAddress()
    const alias = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(alias, account)

    await expect(
      assertValidSenderSignature({
        client: chain({ [account]: [alias.toSuiAddress()] }),
        sender: account,
        transaction: bytes,
        signature,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects the sender’s own key once it is no longer in its alias set', async () => {
    const account = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(account)

    await expect(
      assertValidSenderSignature({
        client: chain({
          [account.toSuiAddress()]: [new Ed25519Keypair().toSuiAddress()],
        }),
        sender: account.toSuiAddress(),
        transaction: bytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(InvalidSenderSignatureError)
  })

  test('rejects a signer outside the sender’s alias set', async () => {
    const account = new Ed25519Keypair().toSuiAddress()
    const stranger = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(stranger, account)

    await expect(
      assertValidSenderSignature({
        client: chain({ [account]: [new Ed25519Keypair().toSuiAddress()] }),
        sender: account,
        transaction: bytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(InvalidSenderSignatureError)
  })

  test('an alias config that can’t be read is a service error, not an invalid signature', async () => {
    const signer = new Ed25519Keypair()
    const { bytes, signature } = await signedTransaction(signer)

    await expect(
      assertValidSenderSignature({
        client: chain({}, true),
        sender: signer.toSuiAddress(),
        transaction: bytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(SenderSignatureVerificationError)
  })
})
