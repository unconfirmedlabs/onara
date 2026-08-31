import { describe, expect, test } from 'bun:test'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  assertValidSenderSignature,
  InvalidSenderSignatureError,
} from './sender-signature'

const SPONSOR = normalizeSuiAddress('0x2')
const CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'
const client = { core: {} } as ClientWithCoreApi

async function signedTransaction(signer: Ed25519Keypair) {
  const transaction = new Transaction()
  transaction.setSender(signer.toSuiAddress())
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
        client,
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
        client,
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
        client,
        sender: signer.toSuiAddress(),
        transaction: changedBytes,
        signature,
      }),
    ).rejects.toBeInstanceOf(InvalidSenderSignatureError)
  })
})
