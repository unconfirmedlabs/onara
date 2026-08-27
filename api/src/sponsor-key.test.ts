import { describe, expect, test } from 'bun:test'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'
import { parseSponsorKeypair } from './sponsor-key'

describe('parseSponsorKeypair', () => {
  test('parses every supported Bech32 Sui private-key scheme', () => {
    const keypairs = [
      Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)),
      Secp256k1Keypair.fromSecretKey(new Uint8Array(32).fill(2)),
      Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(3)),
    ]

    for (const keypair of keypairs) {
      const parsed = parseSponsorKeypair(keypair.getSecretKey())
      expect(parsed.getKeyScheme()).toBe(keypair.getKeyScheme())
      expect(parsed.toSuiAddress()).toBe(keypair.toSuiAddress())
    }
  })

  test('rejects malformed private keys', () => {
    expect(() => parseSponsorKeypair('not-a-private-key')).toThrow()
  })
})
