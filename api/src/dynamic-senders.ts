// Dynamic sender whitelist — a sibling of the static per-policy `senders`
// list. Instead of (or in addition to) a fixed address list, a policy can
// point at an HTTP endpoint that decides, per request, whether the tx sender
// may be sponsored under that policy.
//
// Requests use a dedicated Sui key to sign a domain-separated personal
// message. The receiver recovers the signer from the serialized signature and
// MUST compare it with both X-Onara-Identity and an independently configured
// trusted identity. A caller-provided identity is never a trust root.
//
// Design: fail closed. Any ambiguity (missing/malformed key, signing failure,
// network error, timeout, redirect, unexpected status) is "unavailable",
// never "allow".

import { decodeSuiPrivateKey, type Keypair } from '@mysten/sui/cryptography'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1'
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1'
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import { verifyPersonalMessageSignature } from '@mysten/sui/verify'
import type { DynamicSenderCheck } from './policy'

export class DynamicSenderDeniedError extends Error {}
export class DynamicSenderUnavailableError extends Error {}

/**
 * Minimal KV-like cache surface — matches the subset of Cloudflare's
 * `KVNamespace` this module needs, so it can be swapped out in tests.
 */
export type DynamicSendersCache = {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export const DYNAMIC_SENDER_AUTHORIZATION_DOMAIN =
  'onara.dynamic-senders.v1'
export const DYNAMIC_SENDER_AUTHORIZATION_METHOD = 'GET'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const VISIBLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

export type DynamicSenderAuthorizationFields = {
  audience: string
  sender: string
  requirementName: string
  policyName: string
  network: string
  timestamp: number
  requestId: string
}

export type SignedDynamicSenderAuthorization =
  DynamicSenderAuthorizationFields & {
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
  signingIdentity,
}: {
  audience: string
  url: string
  network: string
  requirementName: string
  policyName: string
  sender: string
  signingIdentity: string
}) =>
  [
    'dynsender',
    'v1',
    audience,
    url,
    network,
    requirementName,
    policyName,
    sender,
    signingIdentity,
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
  fields: DynamicSenderAuthorizationFields,
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
export function buildDynamicSenderAuthorizationMessage(
  fields: DynamicSenderAuthorizationFields,
): Uint8Array {
  assertAuthorizationFields(fields)
  const sender = normalizeSuiAddress(fields.sender)
  return new TextEncoder().encode(
    `${DYNAMIC_SENDER_AUTHORIZATION_DOMAIN}\n` +
      `audience:${fields.audience}\n` +
      `sender:${sender}\n` +
      `requirement:${fields.requirementName}\n` +
      `policy:${fields.policyName}\n` +
      `network:${fields.network}\n` +
      `timestamp:${fields.timestamp}\n` +
      `request-id:${fields.requestId}\n` +
      `method:${DYNAMIC_SENDER_AUTHORIZATION_METHOD}`,
  )
}

/** Parse a Bech32 `suiprivkey...` into one of the SDK's software keypairs. */
export function parseDynamicSenderSigningKey(value: string): Keypair {
  const parsed = decodeSuiPrivateKey(value)
  switch (parsed.scheme) {
    case 'ED25519':
      return Ed25519Keypair.fromSecretKey(parsed.secretKey)
    case 'Secp256k1':
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    case 'Secp256r1':
      return Secp256r1Keypair.fromSecretKey(parsed.secretKey)
    default:
      throw new Error(
        `Unsupported dynamic sender signing key scheme: ${parsed.scheme}`,
      )
  }
}

/**
 * Signs a complete authorization request. Callers may supply `requestId` and
 * `timestamp` for deterministic interoperability tests; production callers
 * should generate a fresh UUID and current timestamp per outbound request.
 */
export async function signDynamicSenderAuthorization({
  signingKey,
  ...fields
}: DynamicSenderAuthorizationFields & {
  signingKey: Keypair
}): Promise<SignedDynamicSenderAuthorization> {
  const normalizedFields = {
    ...fields,
    sender: normalizeSuiAddress(fields.sender),
  }
  const message = buildDynamicSenderAuthorizationMessage(normalizedFields)
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
export async function verifyDynamicSenderAuthorization({
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
}: SignedDynamicSenderAuthorization & {
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
      requestMethod !== DYNAMIC_SENDER_AUTHORIZATION_METHOD ||
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

    const message = buildDynamicSenderAuthorizationMessage(fields)
    const publicKey = await verifyPersonalMessageSignature(message, signature)
    return publicKey.toSuiAddress() === normalizedIdentity
  } catch {
    return false
  }
}

/**
 * Calls the policy's configured dynamic sender endpoint to decide whether
 * `sender` may be sponsored under `policyName`.
 *
 * `sender` MUST originate from the verified transaction bytes, not from an
 * unverified client-supplied field. It is normalized again defensively here.
 *
 * Resolves on allow (204, or a cache hit). Throws `DynamicSenderDeniedError`
 * on an explicit 403, or `DynamicSenderUnavailableError` for everything else
 * (missing/malformed key, signing failure, timeout, redirect, network error,
 * unexpected status). The caller must treat both as "do not sponsor".
 */
export async function checkDynamicSender({
  check,
  requirementName,
  policyName,
  sender,
  network,
  env,
  cache,
  fetchImpl = fetch,
  now = () => Date.now(),
  requestId = () => crypto.randomUUID(),
}: {
  check: DynamicSenderCheck
  requirementName: string
  policyName: string
  sender: string
  network: string
  env: Record<string, unknown>
  cache?: DynamicSendersCache
  fetchImpl?: typeof fetch
  now?: () => number
  requestId?: () => string
}): Promise<void> {
  const privateKey = env[check.signingKeyEnv]
  if (typeof privateKey !== 'string' || privateKey.length === 0) {
    throw new DynamicSenderUnavailableError(
      `Dynamic sender signing key env var "${check.signingKeyEnv}" is missing or empty.`,
    )
  }

  let signingKey: Keypair
  try {
    signingKey = parseDynamicSenderSigningKey(privateKey)
  } catch {
    throw new DynamicSenderUnavailableError(
      `Dynamic sender signing key env var "${check.signingKeyEnv}" is malformed or unsupported.`,
    )
  }

  const derivedIdentity = normalizeSuiAddress(signingKey.toSuiAddress())
  if (
    !isValidSuiAddress(check.signingIdentity) ||
    check.signingIdentity !== normalizeSuiAddress(check.signingIdentity) ||
    derivedIdentity !== check.signingIdentity
  ) {
    throw new DynamicSenderUnavailableError(
      `Dynamic sender signing key env var "${check.signingKeyEnv}" does not match its configured public identity.`,
    )
  }

  if (!isValidSuiAddress(sender)) {
    throw new DynamicSenderUnavailableError(
      'Dynamic sender check received an invalid Sui address.',
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
    throw new DynamicSenderUnavailableError(
      'Dynamic sender authorization fields are malformed.',
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
    signingIdentity: check.signingIdentity,
  })
  const useCache = check.cacheTtlSeconds > 0 && cache !== undefined
  if (useCache) {
    try {
      const hit = await cache!.get(key)
      if (hit === '1') return
      if (hit !== null) {
        console.error(
          JSON.stringify({
            message: 'Ignoring invalid dynamic sender cache entry.',
            policy: policyName,
          }),
        )
      }
    } catch (cause) {
      console.error(
        JSON.stringify({
          message: 'Dynamic sender cache read failed.',
          policy: policyName,
          error: cause instanceof Error ? cause.message : String(cause),
        }),
      )
    }
  }

  let signed: SignedDynamicSenderAuthorization
  try {
    signed = await signDynamicSenderAuthorization({
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
    throw new DynamicSenderUnavailableError(
      'Unable to sign dynamic sender authorization request.',
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
    throw new DynamicSenderUnavailableError(
      'Unable to construct dynamic sender authorization request.',
    )
  }

  let response: Response
  try {
    response = await fetchImpl(check.url, {
      method: DYNAMIC_SENDER_AUTHORIZATION_METHOD,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(check.timeoutMs),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error'
    throw new DynamicSenderUnavailableError(
      `Dynamic sender check request failed: ${message}`,
    )
  }

  if (
    response.type === 'opaqueredirect' ||
    response.redirected ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new DynamicSenderUnavailableError(
      `Dynamic sender check refused redirect response: ${response.status}`,
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
            message: 'Dynamic sender cache write failed.',
            policy: policyName,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      }
    }
    return
  }

  if (response.status === 403) {
    throw new DynamicSenderDeniedError(
      `Sender not in dynamic whitelist for policy "${policyName}".`,
    )
  }

  throw new DynamicSenderUnavailableError(
    `Dynamic sender check returned unexpected status: ${response.status}`,
  )
}
