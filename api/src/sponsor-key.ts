import { decodeSuiPrivateKey, type Keypair } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'

/** Parses a Bech32 `suiprivkey...` sponsor secret into a software keypair. */
export function parseSponsorKeypair(value: string): Keypair {
  const parsed = decodeSuiPrivateKey(value)
  switch (parsed.scheme) {
    case 'ED25519':
      return Ed25519Keypair.fromSecretKey(parsed.secretKey)
    case 'Secp256k1':
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    case 'Secp256r1':
      return Secp256r1Keypair.fromSecretKey(parsed.secretKey)
    default:
      throw new Error(`Unsupported sponsor key scheme: ${parsed.scheme}`)
  }
}
