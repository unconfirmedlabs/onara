import { describe, expect, test } from 'bun:test'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  buildDynamicAuthorizationRequestMessage,
  checkDynamicAuthorization,
  DynamicAuthorizationDeniedError,
  DynamicAuthorizationUnavailableError,
  parseDynamicAuthorizationSigningKey,
  signDynamicAuthorizationRequest,
  verifyDynamicAuthorizationRequest,
  type DynamicAuthorizationRequestFields,
  type DynamicAuthorizationCache,
  type SignedDynamicAuthorizationRequest,
} from './dynamic-authorization'
import type { DynamicAuthorizationCheck } from './policy'

const SENDER = normalizeSuiAddress('0x1')
const OTHER_SENDER = normalizeSuiAddress('0x99')
const REQUIREMENT = 'miso-enoki-sender'
const POLICY = 'miso-sponsored-transactions'
const NETWORK = 'testnet'
const AUDIENCE = 'miso-onara-authorization'
const URL = 'https://example.com/authorize'
const FIXTURE_IDENTITY =
  '0x29dfbf688abce7ab43bb8e70cae158ae961196e721440f515482f8ba1684390f'
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000'
const OTHER_REQUEST_ID = '223e4567-e89b-42d3-a456-426614174000'
const FIXED_NOW = () => 1_700_000_000_000

function expectedCacheKey({
  audience = AUDIENCE,
  url = URL,
  network = NETWORK,
  requirementName = REQUIREMENT,
  policyName = POLICY,
  signingIdentity = FIXTURE_IDENTITY,
}: {
  audience?: string
  url?: string
  network?: string
  requirementName?: string
  policyName?: string
  signingIdentity?: string
} = {}): string {
  return [
    'dynamic-authorization',
    'v1',
    audience,
    url,
    network,
    requirementName,
    policyName,
    SENDER,
    signingIdentity,
  ]
    .map(encodeURIComponent)
    .join(':')
}

const CACHE_KEY = expectedCacheKey()

// Public, deterministic test material only — never use this key in production.
const KEYPAIR = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1))
const PRIVATE_KEY = KEYPAIR.getSecretKey()
const IDENTITY = KEYPAIR.toSuiAddress()
const ATTACKER_KEYPAIR = Ed25519Keypair.fromSecretKey(
  new Uint8Array(32).fill(2),
)

function fields(
  overrides: Partial<DynamicAuthorizationRequestFields> = {},
): DynamicAuthorizationRequestFields {
  return {
    audience: AUDIENCE,
    sender: SENDER,
    requirementName: REQUIREMENT,
    policyName: POLICY,
    network: NETWORK,
    timestamp: 1_700_000_000,
    requestId: REQUEST_ID,
    ...overrides,
  }
}

function config(
  overrides: Partial<DynamicAuthorizationCheck> = {},
): DynamicAuthorizationCheck {
  return {
    kind: 'dynamic-authorization',
    url: URL,
    audience: AUDIENCE,
    signingKeyEnv: 'MISO_ONARA_SIGNING_KEY',
    signingIdentity: IDENTITY,
    timeoutMs: 1500,
    cacheTtlSeconds: 0,
    ...overrides,
  }
}

function env(
  key: string | null = PRIVATE_KEY,
  name = 'MISO_ONARA_SIGNING_KEY',
): Record<string, string> {
  return key === null ? {} : { [name]: key }
}

function memoryCache(): DynamicAuthorizationCache & {
  store: Map<string, string>
} {
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

function verifierInput(
  signed: SignedDynamicAuthorizationRequest,
  overrides: Partial<
    Parameters<typeof verifyDynamicAuthorizationRequest>[0]
  > = {},
): Parameters<typeof verifyDynamicAuthorizationRequest>[0] {
  return {
    ...signed,
    requestMethod: 'GET',
    expectedAudience: AUDIENCE,
    expectedNetwork: NETWORK,
    allowedRequirementPolicies: { [REQUIREMENT]: [POLICY] },
    trustedIdentities: [IDENTITY],
    now: FIXED_NOW,
    ...overrides,
  }
}

describe('canonical Sui personal-message protocol', () => {
  test('matches the deterministic Miso interoperability vector exactly', async () => {
    const message = new TextDecoder().decode(
      buildDynamicAuthorizationRequestMessage(fields()),
    )
    expect(message).toBe(
      'onara.dynamic-authorization.v1\n' +
        'audience:miso-onara-authorization\n' +
        `sender:${SENDER}\n` +
        'requirement:miso-enoki-sender\n' +
        'policy:miso-sponsored-transactions\n' +
        'network:testnet\n' +
        'timestamp:1700000000\n' +
        'request-id:123e4567-e89b-42d3-a456-426614174000\n' +
        'method:GET',
    )
    expect(message.endsWith('\n')).toBe(false)

    expect(PRIVATE_KEY).toBe(
      'suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj',
    )
    expect(IDENTITY).toBe(
      '0x29dfbf688abce7ab43bb8e70cae158ae961196e721440f515482f8ba1684390f',
    )

    const signed = await signDynamicAuthorizationRequest({
      signingKey: KEYPAIR,
      ...fields(),
    })
    expect(signed.signature).toBe(
      'ALnEwszsGcoTR/PnAU4Aa6auMFYH+/wiy+9z9DCmSoyd9qQGRNHD7OvaEs3sGbS5Dp3ohesqQv2oT2dRYTqnygaKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXA==',
    )
    await expect(
      verifyDynamicAuthorizationRequest(verifierInput(signed)),
    ).resolves.toBe(true)
  })

  test('parses all supported Bech32 software key schemes', () => {
    const keypairs = [
      KEYPAIR,
      Secp256k1Keypair.fromSecretKey(new Uint8Array(32).fill(3)),
      Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(4)),
    ]
    for (const keypair of keypairs) {
      const parsed = parseDynamicAuthorizationSigningKey(keypair.getSecretKey())
      expect(parsed.getKeyScheme()).toBe(keypair.getKeyScheme())
      expect(parsed.toSuiAddress()).toBe(keypair.toSuiAddress())
    }
  })

  test('rejects malformed keys, fields, and ambiguous line values', () => {
    expect(() => parseDynamicAuthorizationSigningKey('not-a-key')).toThrow()
    expect(() =>
      buildDynamicAuthorizationRequestMessage(fields({ audience: 'miso\nevil' })),
    ).toThrow(/visible ASCII/)
    expect(() =>
      buildDynamicAuthorizationRequestMessage(
        fields({ requirementName: 'requirement\nevil' }),
      ),
    ).toThrow(/visible ASCII/)
    expect(() =>
      buildDynamicAuthorizationRequestMessage(fields({ policyName: 'p\r\nevil' })),
    ).toThrow(/visible ASCII/)
    expect(() =>
      buildDynamicAuthorizationRequestMessage(fields({ network: ' testnet' })),
    ).toThrow(/visible ASCII/)
    expect(() =>
      buildDynamicAuthorizationRequestMessage(fields({ requestId: 'NOT-A-UUID' })),
    ).toThrow(/UUID v4/)
    expect(() =>
      buildDynamicAuthorizationRequestMessage(fields({ timestamp: Number.NaN })),
    ).toThrow(/timestamp/)
  })
})

describe('receiver reference verifier adversarial cases', () => {
  test('rejects tampering of every signed field and the claimed identity', async () => {
    const signed = await signDynamicAuthorizationRequest({
      signingKey: KEYPAIR,
      ...fields(),
    })
    const tampered: Array<Partial<SignedDynamicAuthorizationRequest>> = [
      { audience: 'other-audience' },
      { sender: OTHER_SENDER },
      { requirementName: 'other-requirement' },
      { policyName: 'other-policy' },
      { network: 'mainnet' },
      { timestamp: signed.timestamp + 1 },
      { requestId: OTHER_REQUEST_ID },
      { identity: ATTACKER_KEYPAIR.toSuiAddress() },
      { signature: 'malformed-signature' },
    ]

    for (const mutation of tampered) {
      await expect(
        verifyDynamicAuthorizationRequest(
          verifierInput({ ...signed, ...mutation }),
        ),
      ).resolves.toBe(false)
    }
  })

  test('rejects cross-audience, cross-requirement, cross-policy, cross-network, and cross-method replay', async () => {
    const signed = await signDynamicAuthorizationRequest({
      signingKey: KEYPAIR,
      ...fields(),
    })
    const receiverMutations: Array<
      Partial<Parameters<typeof verifyDynamicAuthorizationRequest>[0]>
    > = [
      { expectedAudience: 'another-trust-domain' },
      { allowedRequirementPolicies: { 'another-requirement': [POLICY] } },
      { allowedRequirementPolicies: { [REQUIREMENT]: ['another-policy'] } },
      { expectedNetwork: 'mainnet' },
      { requestMethod: 'POST' },
    ]
    for (const mutation of receiverMutations) {
      await expect(
        verifyDynamicAuthorizationRequest(verifierInput(signed, mutation)),
      ).resolves.toBe(false)
    }
  })

  test('rejects stale and future timestamps outside the freshness window', async () => {
    for (const timestamp of [1_700_000_000 - 301, 1_700_000_000 + 301]) {
      const signed = await signDynamicAuthorizationRequest({
        signingKey: KEYPAIR,
        ...fields({ timestamp }),
      })
      await expect(
        verifyDynamicAuthorizationRequest(verifierInput(signed)),
      ).resolves.toBe(false)
    }
  })

  test('rejects an attacker-selected identity even with a valid attacker signature', async () => {
    const attackerSigned = await signDynamicAuthorizationRequest({
      signingKey: ATTACKER_KEYPAIR,
      ...fields(),
    })
    await expect(
      verifyDynamicAuthorizationRequest(verifierInput(attackerSigned)),
    ).resolves.toBe(false)

    // Merely relabeling the attacker's valid signature with a trusted identity
    // also fails because the recovered signer must equal the header.
    await expect(
      verifyDynamicAuthorizationRequest(
        verifierInput({ ...attackerSigned, identity: IDENTITY }),
      ),
    ).resolves.toBe(false)
  })

  test('accepts either independently trusted identity during rotation', async () => {
    const nextSigned = await signDynamicAuthorizationRequest({
      signingKey: ATTACKER_KEYPAIR,
      ...fields(),
    })
    await expect(
      verifyDynamicAuthorizationRequest(
        verifierInput(nextSigned, {
          trustedIdentities: [IDENTITY, ATTACKER_KEYPAIR.toSuiAddress()],
        }),
      ),
    ).resolves.toBe(true)
  })

  test('requires canonical sender and identity header encodings', async () => {
    const signed = await signDynamicAuthorizationRequest({
      signingKey: KEYPAIR,
      ...fields(),
    })
    await expect(
      verifyDynamicAuthorizationRequest(
        verifierInput({ ...signed, sender: '0x1' }),
      ),
    ).resolves.toBe(false)
    await expect(
      verifyDynamicAuthorizationRequest(
        verifierInput({ ...signed, identity: IDENTITY.toUpperCase() }),
      ),
    ).resolves.toBe(false)
  })
})

describe('checkDynamicAuthorization', () => {
  const baseArgs = () => ({
    check: config(),
    requirementName: REQUIREMENT,
    policyName: POLICY,
    sender: SENDER,
    network: NETWORK,
    env: env(),
    now: FIXED_NOW,
    requestId: () => REQUEST_ID,
  })

  test('maps 204 to allow, 403 to deny, and all other statuses to unavailable', async () => {
    const response = (status: number) =>
      (async () => new Response(null, { status })) as unknown as typeof fetch

    await expect(
      checkDynamicAuthorization({ ...baseArgs(), fetchImpl: response(204) }),
    ).resolves.toBeUndefined()
    await expect(
      checkDynamicAuthorization({ ...baseArgs(), fetchImpl: response(403) }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationDeniedError)
    for (const status of [200, 302, 400, 404, 429, 500]) {
      await expect(
        checkDynamicAuthorization({ ...baseArgs(), fetchImpl: response(status) }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    }
  })

  test('sends the exact signed headers, GET method, and requests manual redirect handling', async () => {
    let request: Request | undefined
    let redirect: RequestRedirect | undefined
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = new Request(input as RequestInfo, init)
      redirect = init?.redirect
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await checkDynamicAuthorization({ ...baseArgs(), fetchImpl })
    expect(request?.method).toBe('GET')
    expect(redirect).toBe('manual')
    expect(request?.headers.get('X-Onara-Audience')).toBe(AUDIENCE)
    expect(request?.headers.get('X-Onara-Sender')).toBe(SENDER)
    expect(request?.headers.get('X-Onara-Requirement')).toBe(REQUIREMENT)
    expect(request?.headers.get('X-Onara-Policy')).toBe(POLICY)
    expect(request?.headers.get('X-Onara-Network')).toBe(NETWORK)
    expect(request?.headers.get('X-Onara-Timestamp')).toBe('1700000000')
    expect(request?.headers.get('X-Onara-Request-Id')).toBe(REQUEST_ID)
    expect(request?.headers.get('X-Onara-Identity')).toBe(IDENTITY)
    expect(request?.headers.get('X-Onara-Signature')).toBe(
      'ALnEwszsGcoTR/PnAU4Aa6auMFYH+/wiy+9z9DCmSoyd9qQGRNHD7OvaEs3sGbS5Dp3ohesqQv2oT2dRYTqnygaKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXA==',
    )
    expect(request?.headers.get('User-Agent')).toBe('onara')
  })

  test('rejects a manual redirect response without following it', async () => {
    let authorizationCalls = 0
    let targetCalls = 0
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const { pathname } = new globalThis.URL(request.url)
        if (pathname === '/authorize') {
          authorizationCalls++
          return Response.redirect(
            new globalThis.URL('/target', request.url),
            302,
          )
        }
        if (pathname === '/target') {
          targetCalls++
          return new Response(null, { status: 204 })
        }
        return new Response(null, { status: 404 })
      },
    })

    try {
      await expect(
        checkDynamicAuthorization({
          ...baseArgs(),
          check: config({
            url: new globalThis.URL('/authorize', server.url).toString(),
          }),
          fetchImpl: fetch,
        }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
      expect(authorizationCalls).toBe(1)
      expect(targetCalls).toBe(0)
    } finally {
      await server.stop(true)
    }
  })

  test('rejects every 3xx response before interpreting it', async () => {
    for (const status of [300, 301, 302, 303, 304, 305, 306, 307, 308, 399]) {
      const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
        expect(init?.redirect).toBe('manual')
        return new Response(null, { status })
      }) as unknown as typeof fetch
      await expect(
        checkDynamicAuthorization({ ...baseArgs(), fetchImpl }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    }
  })

  test('rejects evidence of a followed or opaque redirect even with a success status', async () => {
    for (const property of ['redirected', 'type'] as const) {
      const response = new Response(null, { status: 204 })
      Object.defineProperty(response, property, {
        value: property === 'redirected' ? true : 'opaqueredirect',
      })
      const fetchImpl = (async () => response) as unknown as typeof fetch
      await expect(
        checkDynamicAuthorization({ ...baseArgs(), fetchImpl }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    }
  })

  test('treats timeout and network errors as unavailable', async () => {
    const timeoutFetch = ((_input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted.')),
        )
      })) as unknown as typeof fetch
    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        check: config({ timeoutMs: 10 }),
        fetchImpl: timeoutFetch,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)

    const networkFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(
      checkDynamicAuthorization({ ...baseArgs(), fetchImpl: networkFetch }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
  })

  test('fails closed before fetch for missing, empty, or malformed signing keys', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    for (const badEnv of [env(null), env(''), env('not-a-private-key')]) {
      await expect(
        checkDynamicAuthorization({ ...baseArgs(), env: badEnv, fetchImpl }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    }
    expect(calls).toBe(0)
  })

  test('fails closed before cache or fetch when the key does not match the pinned identity', async () => {
    let cacheReads = 0
    let fetchCalls = 0
    const cache: DynamicAuthorizationCache = {
      async get() {
        cacheReads++
        return '1'
      },
      async put() {},
    }
    const fetchImpl = (async () => {
      fetchCalls++
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        check: config({
          signingIdentity: ATTACKER_KEYPAIR.toSuiAddress(),
          cacheTtlSeconds: 60,
        }),
        cache,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    expect(cacheReads).toBe(0)
    expect(fetchCalls).toBe(0)
  })

  test('fails closed for malformed sender, network, or request IDs before fetch', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        sender: 'not-an-address',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        network: 'testnet\nevil',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        requestId: () => 'not-a-uuid',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
    expect(calls).toBe(0)
  })

  test('an exact allow-cache entry cannot bypass canonical signed-field validation', async () => {
    const cases: Array<{
      audience: string
      network: string
      requirementName?: string
      policyName: string
    }> = [
      {
        audience: AUDIENCE,
        network: 'testnet\nevil',
        policyName: POLICY,
      },
      {
        audience: 'miso\nevil',
        network: NETWORK,
        policyName: POLICY,
      },
      {
        audience: AUDIENCE,
        network: NETWORK,
        requirementName: 'requirement\nevil',
        policyName: POLICY,
      },
      {
        audience: AUDIENCE,
        network: NETWORK,
        requirementName: REQUIREMENT,
        policyName: 'miso\nevil',
      },
    ]

    for (const invalid of cases) {
      const cache = memoryCache()
      cache.store.set(expectedCacheKey(invalid), '1')
      let fetchCalls = 0
      const fetchImpl = (async () => {
        fetchCalls++
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch

      await expect(
        checkDynamicAuthorization({
          ...baseArgs(),
          check: config({
            audience: invalid.audience,
            cacheTtlSeconds: 60,
          }),
          network: invalid.network,
          requirementName: invalid.requirementName ?? REQUIREMENT,
          policyName: invalid.policyName,
          cache,
          fetchImpl,
        }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationUnavailableError)
      expect(fetchCalls).toBe(0)
    }
  })

  test('allows distinct endpoints and policies to select distinct signing keys', async () => {
    const identities: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      identities.push(new Request(input as RequestInfo, init).headers.get('X-Onara-Identity')!)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await checkDynamicAuthorization({ ...baseArgs(), fetchImpl })
    await checkDynamicAuthorization({
      ...baseArgs(),
      check: config({
        url: 'https://other.example/authorize',
        audience: 'other-authorizer',
        signingKeyEnv: 'OTHER_SIGNING_KEY',
        signingIdentity: ATTACKER_KEYPAIR.toSuiAddress(),
      }),
      requirementName: 'other-requirement',
      policyName: 'other-policy',
      env: env(ATTACKER_KEYPAIR.getSecretKey(), 'OTHER_SIGNING_KEY'),
      fetchImpl,
    })
    expect(identities).toEqual([IDENTITY, ATTACKER_KEYPAIR.toSuiAddress()])
  })

  test('cache hit skips fetch and only 204 allows are cached with the TTL', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const cache = memoryCache()
    cache.store.set(CACHE_KEY, '1')

    await checkDynamicAuthorization({
      ...baseArgs(),
      check: config({ cacheTtlSeconds: 60 }),
      cache,
      fetchImpl,
    })
    expect(calls).toBe(0)

    cache.store.clear()
    await checkDynamicAuthorization({
      ...baseArgs(),
      check: config({ cacheTtlSeconds: 60 }),
      cache,
      fetchImpl,
    })
    expect(calls).toBe(1)
    expect(cache.store.get(CACHE_KEY)).toBe('1')
  })

  test('deny and unavailable results are never cached', async () => {
    for (const status of [403, 500]) {
      const cache = memoryCache()
      const fetchImpl = (async () =>
        new Response(null, { status })) as unknown as typeof fetch
      await checkDynamicAuthorization({
        ...baseArgs(),
        check: config({ cacheTtlSeconds: 60 }),
        cache,
        fetchImpl,
      }).catch(() => {})
      expect(cache.store.size).toBe(0)
    }
  })

  test('cache failures preserve fail-closed authorization semantics', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const cache: DynamicAuthorizationCache = {
      async get() {
        throw new Error('KV down')
      },
      async put() {
        throw new Error('KV down')
      },
    }
    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        check: config({ cacheTtlSeconds: 60 }),
        cache,
        fetchImpl,
      }),
    ).resolves.toBeUndefined()
    expect(calls).toBe(1)
  })

  test('invalid cache values are ignored and checked with the authorizer', async () => {
    const cache = memoryCache()
    cache.store.set(CACHE_KEY, 'corrupt')
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      return new Response(null, { status: 403 })
    }) as unknown as typeof fetch
    await expect(
      checkDynamicAuthorization({
        ...baseArgs(),
        check: config({ cacheTtlSeconds: 60 }),
        cache,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(DynamicAuthorizationDeniedError)
    expect(calls).toBe(1)
  })

  test('cache entries are isolated by every decision-relevant trust field', async () => {
    const cache = memoryCache()
    cache.store.set(CACHE_KEY, '1')
    for (const mutation of [
      { policyName: 'other-policy' },
      { requirementName: 'other-requirement' },
      { network: 'mainnet' },
      {
        check: config({
          audience: 'other-authorizer',
          cacheTtlSeconds: 60,
        }),
      },
      {
        check: config({
          url: 'https://other.example/authorize',
          cacheTtlSeconds: 60,
        }),
      },
      {
        check: config({
          signingIdentity: ATTACKER_KEYPAIR.toSuiAddress(),
          signingKeyEnv: 'OTHER_SIGNING_KEY',
          cacheTtlSeconds: 60,
        }),
        env: env(ATTACKER_KEYPAIR.getSecretKey(), 'OTHER_SIGNING_KEY'),
      },
    ]) {
      let calls = 0
      const fetchImpl = (async () => {
        calls++
        return new Response(null, { status: 403 })
      }) as unknown as typeof fetch
      await expect(
        checkDynamicAuthorization({
          ...baseArgs(),
          check: config({ cacheTtlSeconds: 60 }),
          ...mutation,
          cache,
          fetchImpl,
        }),
      ).rejects.toBeInstanceOf(DynamicAuthorizationDeniedError)
      expect(calls).toBe(1)
    }
  })
})
