import { describe, expect, test } from 'bun:test'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { OnaraClient } from '../src/client'
import { OnaraError } from '../src/errors'

const BASE_URL = 'https://onara.example.com'

function mockFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    return Promise.resolve(handler(url, init))
  }
}

// ─── status() ────────────────────────────────────────────────────────────────

describe('status()', () => {
  test('returns server status', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        expect(url).toBe(`${BASE_URL}/status`)
        return Response.json({
          network: 'testnet',
          chainId: '4c78adac',
          address: '0xabc',
        })
      }),
    })

    const result = await client.status()
    expect(result).toEqual({
      network: 'testnet',
      chainId: '4c78adac',
      address: '0xabc',
    })
  })
})

// ─── sponsor() ───────────────────────────────────────────────────────────────

describe('sponsor()', () => {
  test('sends correct POST body', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url, init) => {
        expect(init?.method).toBe('POST')
        expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
        const body = JSON.parse(init?.body as string)
        expect(body).toEqual({
          sender: '0x1',
          txBytes: 'AQID',
          txSignature: 'BAUG',
        })
        return Response.json({ digest: '0xresult' })
      }),
    })

    const result = await client.sponsor({
      sender: '0x1',
      txBytes: 'AQID',
      txSignature: 'BAUG',
    })
    expect(result).toEqual({ digest: '0xresult' })
  })

  test('passes dryRun as query param, omits waitForExecution when default', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        const parsed = new URL(url)
        expect(parsed.searchParams.get('dryRun')).toBe('true')
        expect(parsed.searchParams.has('waitForExecution')).toBe(false)
        return Response.json({ dryRun: true, policy: 'test', moveCallTargets: [] })
      }),
    })

    await client.sponsor({
      sender: '0x1',
      txBytes: 'AQID',
      txSignature: 'BAUG',
      dryRun: true,
    })
  })

  test('passes waitForExecution=false as query param when opted out', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        const parsed = new URL(url)
        expect(parsed.searchParams.get('waitForExecution')).toBe('false')
        return Response.json({ digest: '0xresult' })
      }),
    })

    await client.sponsor({
      sender: '0x1',
      txBytes: 'AQID',
      txSignature: 'BAUG',
      waitForExecution: false,
    })
  })

  test('does not let callers disable server-side simulation', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        expect(new URL(url).searchParams.has('simulate')).toBe(false)
        return Response.json({ digest: '0xresult' })
      }),
    })

    await client.sponsor({
      sender: '0x1',
      txBytes: 'AQID',
      txSignature: 'BAUG',
      simulate: false,
    })
  })

  test('throws OnaraError on 400 response', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch(() => {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }),
    })

    try {
      await client.sponsor({
        sender: '0x1',
        txBytes: 'AQID',
        txSignature: 'BAUG',
      })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(OnaraError)
      expect((err as OnaraError).message).toBe('Invalid request')
      expect((err as OnaraError).status).toBe(400)
    }
  })
})

// ─── sponsorTransaction() ────────────────────────────────────────────────────

describe('sponsorTransaction()', () => {
  test('forces address-balance gas instead of falling back to gas coin objects', async () => {
    const signer = new Ed25519Keypair()
    const sponsor = normalizeSuiAddress('0x2')
    const transaction = new Transaction()
    transaction.setGasBudget(10_000_000)
    transaction.setGasPrice(1_000)
    transaction.setExpiration({
      ValidDuring: {
        minEpoch: '1',
        maxEpoch: '2',
        minTimestamp: null,
        maxTimestamp: null,
        chain: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
        nonce: 1,
      },
    })
    // A caller-supplied payment must be overwritten, not retained as a fallback.
    transaction.setGasPayment([
      {
        objectId: normalizeSuiAddress('0x99'),
        version: '1',
        digest: '11111111111111111111111111111111',
      },
    ])
    transaction.moveCall({ target: '0x2::coin::zero', typeArguments: ['0x2::sui::SUI'] })

    const client = new OnaraClient({
      url: BASE_URL,
      client: { core: {} } as ClientWithCoreApi,
      fetch: mockFetch((url, init) => {
        if (url === `${BASE_URL}/status`) {
          return Response.json({
            network: 'testnet',
            chainId: '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD',
            address: sponsor,
          })
        }

        const body = JSON.parse(init?.body as string) as {
          sender: string
          txBytes: string
          txSignature: string
        }
        const data = Transaction.from(body.txBytes).getData()
        expect(data.sender).toBe(normalizeSuiAddress(signer.toSuiAddress()))
        expect(data.gasData.owner).toBe(sponsor)
        expect(data.gasData.payment).toEqual([])
        expect(body.txSignature.length).toBeGreaterThan(0)
        return Response.json({ digest: 'result' })
      }),
    })

    await client.sponsorTransaction({ transaction, signer })
  })
})

// ─── Constructor ─────────────────────────────────────────────────────────────

describe('constructor', () => {
  test('accepts string URL shorthand', async () => {
    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        expect(url).toBe(`${BASE_URL}/status`)
        return Response.json({ chainId: '35834a8a', address: '0x1' })
      }),
    })

    // Verify the string constructor path works the same
    const client2 = new OnaraClient(BASE_URL)
    expect(client2).toBeInstanceOf(OnaraClient)
  })

  test('strips trailing slashes from URL', async () => {
    const client = new OnaraClient({
      url: `${BASE_URL}///`,
      fetch: mockFetch((url) => {
        expect(url).toBe(`${BASE_URL}/status`)
        return Response.json({ chainId: '4c78adac', address: '0x1' })
      }),
    })

    await client.status()
  })
})
