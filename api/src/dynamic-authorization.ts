// Dynamic authorization evaluates a named external requirement for an
// otherwise valid allow branch. The authorizer decides, per request, whether
// the transaction sender may be sponsored under that concrete policy.
//
// Requests use a dedicated Sui key to sign a domain-separated personal
// message. The receiver recovers the signer from the serialized signature and
// MUST compare it with both X-Onara-Identity and an independently configured
// trusted identity. A caller-provided identity is never a trust root.
//
// Design: fail closed. Any ambiguity (signing failure, network error, timeout,
// redirect, or unexpected status) is "unavailable", never "allow".

import type { Keypair } from '@mysten/sui/cryptography'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import type { DynamicAuthorizationCheck } from './policy'

export class DynamicAuthorizationDeniedError extends Error {}
export class DynamicAuthorizationUnavailableError extends Error {}

/**
 * Minimal KV-like cache surface — matches the subset of Cloudflare's
 * `KVNamespace` this module needs, so it can be swapped out in tests.
 */
export type DynamicAuthorizationCache = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export const DYNAMIC_AUTHORIZATION_DOMAIN =
  'onara.dynamic-authorization.v1'
export const DYNAMIC_AUTHORIZATION_REQUEST_METHOD = 'GET'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const VISIBLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

export type DynamicAuthorizationRequestFields = {
  audience: string
  sender: string
  requirementName: string
  policyName: string
  network: string
  timestamp: number
  requestId: string
}

export type SignedDynamicAuthorizationRequest =
  DynamicAuthorizationRequestFields & {
    identity: string
    signature: string
  }

const cacheKey = ({
  audience,
  url,
  network,
  requirementName,
  policyName,
  sender,
  identity,
}: {
  audience: string
  url: string
  network: string
  requirementName: string
  policyName: string
  sender: string
  identity: string
}) =>
  [
    'dynamic-authorization',
    'v1',
    audience,
    url,
    network,
    requirementName,
    policyName,
    sender,
    identity,
  ]
    .map(encodeURIComponent)
    .join(':')

function assertSignedHeaderValue(field: string, value: string): void {
  if (
    value.length > 256 ||
    value !== value.trim() ||
    !VISIBLE_ASCII.test(value)
  ) {
    throw new Error(
      `${field} must contain only visible ASCII with no leading or trailing whitespace.`,
    )
  }
}

function assertAuthorizationFields(
  fields: DynamicAuthorizationRequestFields,
): void {
  assertSignedHeaderValue('audience', fields.audience)
  assertSignedHeaderValue('requirementName', fields.requirementName)
  assertSignedHeaderValue('policyName', fields.policyName)
  assertSignedHeaderValue('network', fields.network)

  if (!isValidSuiAddress(fields.sender)) {
    throw new Error('sender must be a valid Sui address.')
  }
  if (!Number.isSafeInteger(fields.timestamp) || fields.timestamp < 0) {
    throw new Error('timestamp must be a non-negative safe integer.')
  }
  if (!UUID_V4.test(fields.requestId)) {
    throw new Error('requestId must be a lowercase UUID v4.')
  }
}

/**
 * Builds the exact v1 personal-message payload. It is UTF-8 encoded for Sui
 * `signPersonalMessage` with no trailing newline.
 *
 * CR/LF and other non-visible-ASCII characters are rejected in configured
 * values, making this line encoding unambiguous across implementations.
 */
export function buildDynamicAuthorizationRequestMessage(
  fields: DynamicAuthorizationRequestFields,
): Uint8Array {
  assertAuthorizationFields(fields)
  const sender = normalizeSuiAddress(fields.sender)
  return new TextEncoder().encode(
    `${DYNAMIC_AUTHORIZATION_DOMAIN}\n` +
      `audience:${fields.audience}\n` +
      `sender:${sender}\n` +
      `requirement:${fields.requirementName}\n` +
      `policy:${fields.policyName}\n` +
      `network:${fields.network}\n` +
      `timestamp:${fields.timestamp}\n` +
      `request-id:${fields.requestId}\n` +
      `method:${DYNAMIC_AUTHORIZATION_REQUEST_METHOD}`,
  )
}

/**
 * Signs a complete authorization request. Callers may supply `requestId` and
 * `timestamp` for deterministic interoperability tests; production callers
 * should generate a fresh UUID and current timestamp per outbound request.
 */
export async function signDynamicAuthorizationRequest({
  signingKey,
  ...fields
}: DynamicAuthorizationRequestFields & {
  signingKey: Keypair
}): Promise<SignedDynamicAuthorizationRequest> {
  const normalizedFields = {
    ...fields,
    sender: normalizeSuiAddress(fields.sender),
  }
  const message = buildDynamicAuthorizationRequestMessage(normalizedFields)
  const { signature } = await signingKey.signPersonalMessage(message)

  return {
    ...normalizedFields,
    identity: normalizeSuiAddress(signingKey.toSuiAddress()),
    signature,
  }
}

/**
 * Receiver-side reference verifier for the v1 protocol.
 *
 * Trust inputs (`expectedAudience`, `expectedNetwork`,
 * `allowedRequirementPolicies`, and `trustedIdentities`) must come from
 * receiver configuration, never from the request. The recovered signer must
 * equal the claimed identity and one of the configured trusted identities. A
 * request ID is signed but is not replay prevention by itself; receivers that
 * need single-use requests must persist consumed IDs for at least the accepted
 * timestamp window.
 */
export async function verifyDynamicAuthorizationRequest({
  requestMethod,
  expectedAudience,
  expectedNetwork,
  allowedRequirementPolicies,
  trustedIdentities,
  identity,
  signature,
  maxSkewSeconds = 300,
  now = () => Date.now(),
  ...fields
}: SignedDynamicAuthorizationRequest & {
  requestMethod: string
  expectedAudience: string
  expectedNetwork: string
  allowedRequirementPolicies: Readonly<Record<string, readonly string[]>>
  trustedIdentities: readonly string[]
  maxSkewSeconds?: number
  now?: () => number
}): Promise<boolean> {
  try {
    if (
      requestMethod !== DYNAMIC_AUTHORIZATION_REQUEST_METHOD ||
      fields.audience !== expectedAudience ||
      fields.network !== expectedNetwork ||
      !allowedRequirementPolicies[fields.requirementName]?.includes(
        fields.policyName,
      )
    ) {
      return false
    }

    assertSignedHeaderValue('expectedAudience', expectedAudience)
    assertSignedHeaderValue('expectedNetwork', expectedNetwork)
    const nowSeconds = Math.floor(now() / 1000)
    if (
      !Number.isSafeInteger(nowSeconds) ||
      !Number.isFinite(maxSkewSeconds) ||
      maxSkewSeconds < 0 ||
      Math.abs(nowSeconds - fields.timestamp) > maxSkewSeconds
    ) {
      return false
    }

    if (!isValidSuiAddress(identity)) return false
    const normalizedIdentity = normalizeSuiAddress(identity)
    if (identity !== normalizedIdentity) return false

    const trusted = new Set(
      trustedIdentities.map((address) => {
        if (!isValidSuiAddress(address)) {
          throw new Error('Invalid trusted Sui identity.')
        }
        return normalizeSuiAddress(address)
      }),
    )
    if (!trusted.has(normalizedIdentity)) return false

    // Request headers themselves are canonical: accepting a short sender and
    // normalizing only for signature reconstruction would create two wire
    // representations for one signed statement.
    if (
      !isValidSuiAddress(fields.sender) ||
      fields.sender !== normalizeSuiAddress(fields.sender)
    ) {
      return false
    }

    const message = buildDynamicAuthorizationRequestMessage(fields)
    const publicKey = await verifyPersonalMessageSignature(message, signature)
    return publicKey.toSuiAddress() === normalizedIdentity
  } catch {
    return false
  }
}

/**
 * Calls the policy's configured dynamic authorization endpoint to decide whether
 * `sender` may be sponsored under `policyName`.
 *
 * `sender` MUST originate from the verified transaction bytes, not from an
 * unverified client-supplied field. It is normalized again defensively here.
 *
 * Resolves on allow (204, or a cache hit). Throws
 * `DynamicAuthorizationDeniedError` on an explicit 403, or
 * `DynamicAuthorizationUnavailableError` for everything else (signing
 * failure, timeout, redirect, network error, or an unexpected status). The
 * caller must treat both as "do not sponsor".
 */
export async function checkDynamicAuthorization({
  check,
  requirementName,
  policyName,
  sender,
  network,
  signingKey,
  cache,
  fetchImpl = fetch,
  now = () => Date.now(),
  requestId = () => crypto.randomUUID(),
  signal,
}: {
  check: DynamicAuthorizationCheck
  requirementName: string
  policyName: string
  sender: string
  network: string
  signingKey: Keypair
  cache?: DynamicAuthorizationCache
  fetchImpl?: typeof fetch
  now?: () => number
  requestId?: () => string
  signal?: AbortSignal
}): Promise<void> {
  let identity: string
  try {
    identity = normalizeSuiAddress(signingKey.toSuiAddress())
  } catch {
    throw new DynamicAuthorizationUnavailableError(
      'Unable to derive the dynamic authorization signing identity.',
    )
  }

  if (!isValidSuiAddress(sender)) {
    throw new DynamicAuthorizationUnavailableError(
      'Dynamic authorization check received an invalid Sui address.',
    )
  }
  const normalizedSender = normalizeSuiAddress(sender)

  // Validate every runtime/config value that would be copied into the signed
  // statement before consulting the allow cache. Otherwise a pre-existing KV
  // entry could bypass canonicalization of a malformed runtime network (or a
  // defense-in-depth schema violation in audience/policy).
  try {
    assertSignedHeaderValue('audience', check.audience)
    assertSignedHeaderValue('requirementName', requirementName)
    assertSignedHeaderValue('policyName', policyName)
    assertSignedHeaderValue('network', network)
  } catch {
    throw new DynamicAuthorizationUnavailableError(
      'Dynamic authorization fields are malformed.',
    )
  }

  // Cache failures are never fatal: a broken KV must not turn into a 503 for
  // a sender the authorizer would allow — fall through to the HTTP check.
  const key = cacheKey({
    audience: check.audience,
    url: check.url,
    network,
    requirementName,
    policyName,
    sender: normalizedSender,
    identity,
  })
  const useCache = check.cacheTtlSeconds > 0 && cache !== undefined
  if (useCache) {
    try {
      const hit = await cache!.get(key)
      if (hit === '1') return
      if (hit !== null) {
        console.error(
          JSON.stringify({
            message: 'Ignoring invalid dynamic authorization cache entry.',
            policy: policyName,
          }),
        )
      }
    } catch (cause) {
      console.error(
        JSON.stringify({
          message: 'Dynamic authorization cache read failed.',
          policy: policyName,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      )
    }
  }

  let signed: SignedDynamicAuthorizationRequest
  try {
    signed = await signDynamicAuthorizationRequest({
      signingKey,
      audience: check.audience,
      sender: normalizedSender,
      requirementName,
      policyName,
      network,
      timestamp: Math.floor(now() / 1000),
      requestId: requestId(),
    })
  } catch {
    throw new DynamicAuthorizationUnavailableError(
      'Unable to sign dynamic authorization request.',
    )
  }

  let headers: Headers
  try {
    headers = new Headers({
      'X-Onara-Audience': signed.audience,
      'X-Onara-Sender': signed.sender,
      'X-Onara-Requirement': signed.requirementName,
      'X-Onara-Policy': signed.policyName,
      'X-Onara-Network': signed.network,
      'X-Onara-Timestamp': String(signed.timestamp),
      'X-Onara-Request-Id': signed.requestId,
      'X-Onara-Identity': signed.identity,
      'X-Onara-Signature': signed.signature,
      'User-Agent': 'onara',
    })
  } catch {
    throw new DynamicAuthorizationUnavailableError(
      'Unable to construct dynamic authorization request.',
    )
  }

  let response: Response
  try {
    response = await fetchImpl(check.url, {
      method: DYNAMIC_AUTHORIZATION_REQUEST_METHOD,
      headers,
      redirect: 'manual',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(check.timeoutMs)])
        : AbortSignal.timeout(check.timeoutMs),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error'
    throw new DynamicAuthorizationUnavailableError(
      `Dynamic authorization check request failed: ${message}`,
    )
  }

  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new DynamicAuthorizationUnavailableError(
      `Dynamic authorization check refused redirect response: ${response.status}`,
    )
  }

  if (response.status === 204) {
    if (useCache) {
      try {
        await cache!.put(key, '1', {
          expirationTtl: check.cacheTtlSeconds,
        })
      } catch (cause) {
        console.error(
          JSON.stringify({
            message: 'Dynamic authorization cache write failed.',
            policy: policyName,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      }
    }
    return
  }

  if (response.status === 403) {
    throw new DynamicAuthorizationDeniedError(
      `Dynamic authorization denied for policy "${policyName}".`,
    )
  }

  throw new DynamicAuthorizationUnavailableError(
    `Dynamic authorization check returned unexpected status: ${response.status}`,
  )
}
