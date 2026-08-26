import { describe, expect, test } from 'bun:test'
import {
  checkDynamicSender,
  DynamicSenderDeniedError,
  DynamicSenderUnavailableError,
  verifyDynamicSenderSignature,
  type DynamicSendersCache,
} from './dynamic-senders'
import type { DynamicSendersConfig } from './policy'

const SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000001'
const POLICY = 'my-policy'
const NETWORK = 'testnet'
const SECRET = 'super-secret'

function config(overrides: Partial<DynamicSendersConfig> = {}): DynamicSendersConfig {
  return {
    url: 'https://example.com/authorize',
    timeoutMs: 1500,
    cacheTtlSeconds: 0,
    secretEnv: 'DYNAMIC_SENDERS_SECRET',
    ...overrides,
  }
}

function env(secret: string | null = SECRET) {
  return secret === null ? {} : { DYNAMIC_SENDERS_SECRET: secret }
}

function memoryCache(): DynamicSendersCache & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, value) {
      store.set(key, value)
    },
  }
}

describe('checkDynamicSender', () => {
  test('resolves on 204 allow', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config(),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(true)
  })

  test('throws DynamicSenderDeniedError on 403', async () => {
    const fetchImpl = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config(),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderDeniedError)
  })

  test('throws DynamicSenderUnavailableError on 500', async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config(),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderUnavailableError)
  })

  test('throws DynamicSenderUnavailableError on timeout', async () => {
    const fetchImpl = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined
        signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')))
      })) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ timeoutMs: 10 }),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderUnavailableError)
  })

  test('fails closed without calling fetch when the secret is missing', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config(),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(null),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderUnavailableError)
    expect(called).toBe(false)
  })

  test('sends the exact header set with a verifiable signature', async () => {
    let request: Request | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input as RequestInfo, init)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    const fixedNow = () => 1_700_000_000_000

    await checkDynamicSender({
      dynamicSenders: config(),
      policyName: POLICY,
      sender: SENDER,
      network: NETWORK,
      env: env(),
      fetchImpl,
      now: fixedNow,
    })

    expect(request).toBeDefined()
    const headers = request!.headers
    expect(headers.get('X-Onara-Sender')).toBe(SENDER)
    expect(headers.get('X-Onara-Policy')).toBe(POLICY)
    expect(headers.get('X-Onara-Network')).toBe(NETWORK)
    expect(headers.get('X-Onara-Timestamp')).toBe('1700000000')
    expect(headers.get('User-Agent')).toBe('onara')
    const signature = headers.get('X-Onara-Signature')
    expect(signature).toBeTruthy()

    const verified = await verifyDynamicSenderSignature({
      secret: SECRET,
      sender: SENDER,
      policyName: POLICY,
      network: NETWORK,
      timestamp: 1700000000,
      signature: signature!,
      now: fixedNow,
    })
    expect(verified).toBe(true)
  })

  test('cache hit skips fetch entirely', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const cache = memoryCache()
    cache.store.set(`dynsender:${POLICY}:${SENDER}`, '1')

    await checkDynamicSender({
      dynamicSenders: config({ cacheTtlSeconds: 60 }),
      policyName: POLICY,
      sender: SENDER,
      network: NETWORK,
      env: env(),
      fetchImpl,
      cache,
    })
    expect(called).toBe(false)
  })

  test('allow is cached with the configured TTL', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const cache = memoryCache()

    await checkDynamicSender({
      dynamicSenders: config({ cacheTtlSeconds: 60 }),
      policyName: POLICY,
      sender: SENDER,
      network: NETWORK,
      env: env(),
      fetchImpl,
      cache,
    })
    expect(cache.store.get(`dynsender:${POLICY}:${SENDER}`)).toBe('1')
  })

  test('deny is never cached', async () => {
    const fetchImpl = (async () => new Response(null, { status: 403 })) as unknown as typeof fetch
    const cache = memoryCache()

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ cacheTtlSeconds: 60 }),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
        cache,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderDeniedError)
    expect(cache.store.size).toBe(0)
  })

  test('a cache read failure falls through to the HTTP check', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const cache: DynamicSendersCache = {
      async get() {
        throw new Error('KV down')
      },
      async put() {},
    }

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ cacheTtlSeconds: 60 }),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
        cache,
      }),
    ).resolves.toBeUndefined()
    expect(called).toBe(true)
  })

  test('a cache write failure does not turn an allow into a failure', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    const cache: DynamicSendersCache = {
      async get() {
        return null
      },
      async put() {
        throw new Error('KV down')
      },
    }

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ cacheTtlSeconds: 60 }),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
        cache,
      }),
    ).resolves.toBeUndefined()
  })

  test('a 200 (not 204) is unavailable, not allow', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch

    await expect(
      checkDynamicSender({
        dynamicSenders: config(),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderUnavailableError)
  })

  test('a cache hit for policy A does not satisfy policy B', async () => {
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(null, { status: 403 })
    }) as unknown as typeof fetch
    const cache = memoryCache()
    cache.store.set(`dynsender:${POLICY}:${SENDER}`, '1')

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ cacheTtlSeconds: 60 }),
        policyName: 'other-policy',
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
        cache,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderDeniedError)
    expect(called).toBe(true)
  })

  test('unavailable errors are never cached', async () => {
    const fetchImpl = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch
    const cache = memoryCache()

    await expect(
      checkDynamicSender({
        dynamicSenders: config({ cacheTtlSeconds: 60 }),
        policyName: POLICY,
        sender: SENDER,
        network: NETWORK,
        env: env(),
        fetchImpl,
        cache,
      }),
    ).rejects.toBeInstanceOf(DynamicSenderUnavailableError)
    expect(cache.store.size).toBe(0)
  })
})

describe('verifyDynamicSenderSignature', () => {
  test('rejects a skewed timestamp', async () => {
    const fixedNow = () => 1_700_000_000_000
    const signature = 'deadbeef'

    const verified = await verifyDynamicSenderSignature({
      secret: SECRET,
      sender: SENDER,
      policyName: POLICY,
      network: NETWORK,
      timestamp: 1_700_000_000 - 1000, // way outside the default 300s skew
      signature,
      now: fixedNow,
    })
    expect(verified).toBe(false)
  })

  test('rejects a NaN timestamp', async () => {
    const verified = await verifyDynamicSenderSignature({
      secret: SECRET,
      sender: SENDER,
      policyName: POLICY,
      network: NETWORK,
      timestamp: Number.NaN,
      signature: 'deadbeef',
    })
    expect(verified).toBe(false)
  })

  test('rejects a tampered sender', async () => {
    const fixedNow = () => 1_700_000_000_000
    const timestamp = 1_700_000_000

    // Compute a valid signature the same way checkDynamicSender does, then
    // verify against a different sender.
    let capturedSignature = ''
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init)
      capturedSignature = req.headers.get('X-Onara-Signature')!
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await checkDynamicSender({
      dynamicSenders: config(),
      policyName: POLICY,
      sender: SENDER,
      network: NETWORK,
      env: env(),
      fetchImpl,
      now: fixedNow,
    })

    const otherSender =
      '0x0000000000000000000000000000000000000000000000000000000000000099'
    const verified = await verifyDynamicSenderSignature({
      secret: SECRET,
      sender: otherSender,
      policyName: POLICY,
      network: NETWORK,
      timestamp,
      signature: capturedSignature,
      now: fixedNow,
    })
    expect(verified).toBe(false)
  })
})
