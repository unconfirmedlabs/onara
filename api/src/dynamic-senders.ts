// Dynamic sender whitelist — a sibling of the static per-policy `senders`
// list. Instead of (or in addition to) a fixed address list, a policy can
// point at an HTTP endpoint that decides, per request, whether the tx
// sender may be sponsored under that policy.
//
// Design: fail closed. Any ambiguity (missing secret, network error,
// timeout, unexpected status) is treated as "unavailable", never as "allow".

import type { DynamicSendersConfig } from './policy'

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

const cacheKey = (policyName: string, sender: string) =>
  `dynsender:${policyName}:${sender}`

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  )
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Calls the policy's configured `dynamicSenders` endpoint to decide whether
 * `sender` may be sponsored under `policyName`.
 *
 * `sender` MUST be the normalized address parsed from the transaction bytes
 * (`txData.sender`), not the request JSON `sender` field — the caller is
 * responsible for passing the value that was actually verified against the
 * transaction, not an unverified client-supplied string.
 *
 * Resolves on allow (204, or a cache hit). Throws `DynamicSenderDeniedError`
 * on an explicit 403, or `DynamicSenderUnavailableError` for everything else
 * (missing secret, timeout, network error, unexpected status) — the caller
 * must treat both as "do not sponsor".
 */
export async function checkDynamicSender({
  dynamicSenders,
  policyName,
  sender,
  network,
  env,
  cache,
  fetchImpl = fetch,
  now = () => Date.now(),
}: {
  dynamicSenders: DynamicSendersConfig
  policyName: string
  sender: string
  network: string
  env: Record<string, unknown>
  cache?: DynamicSendersCache
  fetchImpl?: typeof fetch
  now?: () => number
}): Promise<void> {
  const secret = env[dynamicSenders.secretEnv]
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new DynamicSenderUnavailableError(
      `Dynamic senders secret env var "${dynamicSenders.secretEnv}" is missing or empty.`,
    )
  }

  // Cache failures are never fatal: a broken KV must not turn into a 503 for
  // a sender the authorizer would allow — fall through to the HTTP check.
  const key = cacheKey(policyName, sender)
  const useCache = dynamicSenders.cacheTtlSeconds > 0 && cache !== undefined
  if (useCache) {
    try {
      const hit = await cache!.get(key)
      if (hit !== null) return
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

  const timestamp = Math.floor(now() / 1000)
  const signature = await hmacSha256Hex(
    secret,
    `${sender}\n${policyName}\n${network}\n${timestamp}`,
  )

  const headers = new Headers({
    'X-Onara-Sender': sender,
    'X-Onara-Policy': policyName,
    'X-Onara-Network': network,
    'X-Onara-Timestamp': String(timestamp),
    'X-Onara-Signature': signature,
    'User-Agent': 'onara',
  })

  let response: Response
  try {
    response = await fetchImpl(dynamicSenders.url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(dynamicSenders.timeoutMs),
    })
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error'
    throw new DynamicSenderUnavailableError(
      `Dynamic sender check request failed: ${message}`,
    )
  }

  if (response.status === 204) {
    if (useCache) {
      try {
        await cache!.put(key, '1', {
          expirationTtl: dynamicSenders.cacheTtlSeconds,
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

/**
 * Verifies a request built by `checkDynamicSender` on the receiving end. App
 * authors can reuse this exact scheme to validate the `X-Onara-*` headers.
 */
export function verifyDynamicSenderSignature({
  secret,
  sender,
  policyName,
  network,
  timestamp,
  signature,
  maxSkewSeconds = 300,
  now = () => Date.now(),
}: {
  secret: string
  sender: string
  policyName: string
  network: string
  timestamp: number
  signature: string
  maxSkewSeconds?: number
  now?: () => number
}): Promise<boolean> {
  const nowSeconds = Math.floor(now() / 1000)
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(nowSeconds - timestamp) > maxSkewSeconds
  ) {
    return Promise.resolve(false)
  }

  return hmacSha256Hex(
    secret,
    `${sender}\n${policyName}\n${network}\n${timestamp}`,
  ).then((expected) => timingSafeEqual(expected, signature))
}
