import { describe, expect, test } from 'bun:test'
import { OnaraClient } from '../src/client'
import { OnaraError } from '../src/errors'
import type { PolicyConfig } from '../src/types'

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

// ─── policies() ──────────────────────────────────────────────────────────────

describe('policies()', () => {
  test('returns policy configs array', async () => {
    const policies: PolicyConfig[] = [
      {
        type: 'require',
        name: 'signed-in-user',
        check: {
          kind: 'sender.dynamic',
          url: 'https://api.example.com/v1/onara/authorize',
          audience: 'example-onara-authorization',
          signingKeyEnv: 'ONARA_SIGNING_KEY',
          signingIdentity: `0x${'1'.repeat(64)}`,
          timeoutMs: 1_500,
          cacheTtlSeconds: 0,
        },
      },
      {
        type: 'deny',
        name: 'emergency-stop',
        enabled: false,
        when: { kind: 'always' },
      },
      {
        type: 'allow',
        name: 'test-policy',
        requires: ['signed-in-user'],
        gasBudgetMax: '1000000000',
        commands: { allowed: ['MoveCall'], max: 2 },
        calls: {
          mode: 'sequence',
          rules: [
            {
              id: 'zero',
              targets: ['0x2::balance::zero'],
              count: { min: 1, max: 1 },
            },
            {
              id: 'send',
              targets: ['0x2::balance::send_funds'],
            },
          ],
          resultFlow: [
            {
              from: { rule: 'zero', result: 0 },
              to: [{ rule: 'send', argument: 0 }],
            },
          ],
        },
      },
    ]

    const client = new OnaraClient({
      url: BASE_URL,
      fetch: mockFetch((url) => {
        expect(url).toBe(`${BASE_URL}/policies`)
        return Response.json(policies)
      }),
    })

    const result = await client.policies()
    expect(result).toEqual(policies)
    expect(result.map((policy) => policy.type)).toEqual([
      'require',
      'deny',
      'allow',
    ])
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
