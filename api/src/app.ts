import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timing, startTime, endTime } from 'hono/timing'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport'
import type { Keypair } from '@mysten/sui/cryptography'
import { isValidSuiAddress } from '@mysten/sui/utils'
import { loadPolicies } from './policy'
import type { DynamicAuthorizationCache } from './dynamic-authorization'
import { writeAnalytics } from './analytics'
import {
  parseGasBudgetMax,
  type RateLimitBinding,
} from './request-guards'
import sponsorPoliciesConfig from '../policies'
import { parseSponsorKeypair } from './sponsor-key'
import {
  sponsorRequest,
  SponsorshipFailure,
  sponsorshipHttpStatus,
  type SponsorshipDependencies,
  type SponsorshipStage,
} from './sponsorship-service'

interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    indexes?: string[]
    blobs?: string[]
    doubles?: number[]
  }): void
}

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_PRIVATE_KEY: string
  DRY_RUN_ONLY?: string
  EXECUTION_TIMEOUT_MS?: string
  CONFIRMATION_TIMEOUT_MS?: string
  GAS_BUDGET_MAX?: string
  ANALYTICS?: AnalyticsEngineDataset
  HAYABUSA?: { fetch: typeof fetch }
  SENDER_RATE_LIMIT?: RateLimitBinding
  IP_RATE_LIMIT?: RateLimitBinding
  DYNAMIC_AUTHORIZATION_CACHE?: DynamicAuthorizationCache
}

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000
const MAX_CALLER_TIMEOUT_MS = 60_000

const app = new Hono()

app.use(cors())
app.use(timing())
app.use(async (c, next) => {
  const { HAYABUSA } = env<Bindings>(c)
  c.header('x-onara-transport', HAYABUSA ? 'hayabusa' : 'direct')
  await next()
})

// Global variable cache — persists across requests within the same Worker instance.
// Cloudflare Workers run one instance per edge node; global state survives between
// invocations but is lost on eviction. We key by config to handle redeployments
// that change env vars.
let _grpcClient: SuiGrpcClient | null = null
let _grpcClientKey = ''

const getGrpcClient = (network: string, baseUrl: string, serviceBinding?: { fetch: typeof fetch }): SuiGrpcClient => {
  const key = serviceBinding ? `${network}:binding` : `${network}:${baseUrl}`
  if (_grpcClient && _grpcClientKey === key) return _grpcClient
  if (serviceBinding) {
    const transport = new GrpcWebFetchTransport({
      baseUrl,
      fetch: ((input, init) => serviceBinding.fetch(input, init)) as typeof fetch,
    })
    _grpcClient = new SuiGrpcClient({ network, transport })
  } else {
    _grpcClient = new SuiGrpcClient({ network, baseUrl })
  }
  _grpcClientKey = key
  return _grpcClient
}

// Wraps a hayabusa service binding's fetch to capture the responding backend hash
// and inject it as x-hayabusa-prefer-backend on subsequent calls. Scoped per
// instance — create one per request so concurrent handlers don't share state.
const createPinningFetch = (serviceBinding: { fetch: typeof fetch }): typeof fetch => {
  let preferredBackend: string | null = null
  return (async (input, init) => {
    const headers = new Headers(init?.headers)
    if (preferredBackend) headers.set('x-hayabusa-prefer-backend', preferredBackend)
    const res = await serviceBinding.fetch(input, { ...init, headers })
    const backend = res.headers.get('x-hayabusa-backend')
    if (backend) preferredBackend = backend
    return res
  }) as typeof fetch
}

let _keypair: Keypair | null = null
let _keypairKey = ''
let _sponsorAddress = ''

const getKeyPair = (privateKey: string): Keypair => {
  if (_keypair && _keypairKey === privateKey) return _keypair
  _keypair = parseSponsorKeypair(privateKey)
  _keypairKey = privateKey
  _sponsorAddress = _keypair.toSuiAddress()
  return _keypair
}

const getSponsorAddress = (privateKey: string): string => {
  if (_sponsorAddress && _keypairKey === privateKey) return _sponsorAddress
  getKeyPair(privateKey)
  return _sponsorAddress
}

const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/
const base64Field = z
  .string()
  .trim()
  .min(1, 'Missing base64 payload.')
  .regex(base64Regex, 'Invalid base64 payload.')

const sponsorPayloadSchema = z.object({
  sender: z.string().refine(isValidSuiAddress, 'Invalid Sui address.'),
  txBytes: base64Field,
  txSignature: base64Field,
})

const SPONSORED_POLICIES = loadPolicies(sponsorPoliciesConfig)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveExecutionTimeout(bindings: Bindings, callerValue?: string): number {
  const serverMax = parseConfiguredTimeout(
    bindings.EXECUTION_TIMEOUT_MS,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    'EXECUTION_TIMEOUT_MS',
  )
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function resolveConfirmationTimeout(bindings: Bindings, callerValue?: string): number {
  const serverMax = parseConfiguredTimeout(
    bindings.CONFIRMATION_TIMEOUT_MS,
    DEFAULT_CONFIRMATION_TIMEOUT_MS,
    'CONFIRMATION_TIMEOUT_MS',
  )
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function parseConfiguredTimeout(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`)
  }
  return parsed
}

function parseBool(value: string | undefined): boolean {
  return value === 'true' || value === '1'
}

function createGrpcClient(bindings: Bindings): SuiGrpcClient {
  if (!bindings.HAYABUSA) return getGrpcClient(bindings.SUI_NETWORK, bindings.SUI_GRPC_URL)
  // Supply the binding-backed fetch through a pre-built transport.
  const transport = new GrpcWebFetchTransport({
    baseUrl: bindings.SUI_GRPC_URL,
    fetch: createPinningFetch(bindings.HAYABUSA),
  })
  return new SuiGrpcClient({ network: bindings.SUI_NETWORK, transport })
}

function createSponsorshipDependencies(
  bindings: Bindings,
): SponsorshipDependencies {
  const keypair = getKeyPair(bindings.SUI_PRIVATE_KEY)
  const gasBudgetMax = parseGasBudgetMax(bindings.GAS_BUDGET_MAX)
  if (
    gasBudgetMax === null &&
    SPONSORED_POLICIES.allow.some(
      (policy) => policy.enabled && policy.gasBudgetMax === null,
    )
  ) {
    throw new Error(
      'GAS_BUDGET_MAX is required unless every enabled allow policy sets gasBudgetMax.',
    )
  }
  return {
    client: createGrpcClient(bindings),
    keypair,
    sponsorAddress: keypair.toSuiAddress(),
    network: bindings.SUI_NETWORK,
    policies: SPONSORED_POLICIES,
    gasBudgetMax,
    forceValidateOnly: parseBool(bindings.DRY_RUN_ONLY),
    senderRateLimit: bindings.SENDER_RATE_LIMIT,
    ipRateLimit: bindings.IP_RATE_LIMIT,
    dynamicAuthorizationCache: bindings.DYNAMIC_AUTHORIZATION_CACHE,
  }
}

const STAGE_LABELS: Record<SponsorshipStage, string> = {
  guard: 'Gas budget cap & IP rate limiting',
  signature: 'Sender signature verification',
  'sender-rate-limit': 'Sender rate limiting',
  context: 'Policy context resolution',
  policy: 'Policy validation',
  ownership: 'Owned input authorization',
  requirements: 'Policy requirement checks',
  simulation: 'Transaction simulation',
  execution: 'Sign & execute transaction',
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/status', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_PRIVATE_KEY, HAYABUSA } = env<Bindings>(c)

  startTime(c, 'init', 'Client & keypair init')
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL, HAYABUSA)
  const address = getSponsorAddress(SUI_PRIVATE_KEY)
  endTime(c, 'init')

  let chainId: string | null = null
  let balances: { active: string; pending: string } | null = null
  try {
    startTime(c, 'rpc', 'Chain ID & balance fetch')
    const [chainResult, balanceResult] = await Promise.all([
      grpcClient.core.getChainIdentifier(),
      grpcClient.getBalance({ owner: address }),
    ])
    endTime(c, 'rpc')
    chainId = chainResult.chainIdentifier
    balances = {
      active: balanceResult.balance.addressBalance,
      pending: balanceResult.balance.coinBalance,
    }
  } catch {}
  return c.json({
    network: SUI_NETWORK,
    chainId,
    address,
    balances,
    transport: HAYABUSA ? 'hayabusa' : 'direct',
  })
})

// ─── Transaction status lookup ────────────────────────────────────────────────

app.get('/sponsor/:digest/status', async (c) => {
  const bindings = env<Bindings>(c)
  const digest = c.req.param('digest')
  const grpcClient = getGrpcClient(bindings.SUI_NETWORK, bindings.SUI_GRPC_URL, bindings.HAYABUSA)

  try {
    const tx = await grpcClient.getTransaction({ digest, include: { effects: true, events: true } })
    return c.json({ found: true, ...tx })
  } catch {
    return c.json({ found: false, digest }, 404)
  }
})

// ─── HTTP sponsorship ─────────────────────────────────────────────────────────

app.post('/sponsor', async (c) => {
  const bindings = env<Bindings>(c)
  const { ANALYTICS, SUI_GRPC_URL } = bindings
  const waitForExecution = c.req.query('waitForExecution') !== 'false'
  const validateOnly = parseBool(c.req.query('dryRun'))
  let executionTimeoutMs: number
  let confirmationTimeoutMs: number
  try {
    executionTimeoutMs = resolveExecutionTimeout(bindings, c.req.query('executionTimeoutMs') ?? undefined)
    confirmationTimeoutMs = resolveConfirmationTimeout(bindings, c.req.query('confirmationTimeoutMs') ?? undefined)
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Invalid sponsorship timeout configuration.',
      },
      500,
    )
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON.' }, 400)
  }

  const parsed = sponsorPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'Invalid request payload.'
    return c.json({ error: issue }, 400)
  }

  startTime(c, 'init', 'Client & keypair init')
  let dependencies: SponsorshipDependencies
  try {
    dependencies = createSponsorshipDependencies(bindings)
  } catch (error) {
    endTime(c, 'init')
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Unable to initialize sponsorship service.',
      },
      500,
    )
  }
  endTime(c, 'init')

  let sponsorship
  try {
    sponsorship = await sponsorRequest({
      request: {
        payload: parsed.data,
        ip: c.req.header('cf-connecting-ip') ?? 'unknown',
        mode: validateOnly ? 'validate-only' : 'execute',
        waitForExecution,
        executionTimeoutMs,
        confirmationTimeoutMs,
      },
      dependencies,
      onStage: (stage, phase) => {
        if (phase === 'start') {
          startTime(c, stage, STAGE_LABELS[stage])
        } else {
          endTime(c, stage)
        }
      },
    })
  } catch (error) {
    if (error instanceof SponsorshipFailure) {
      return c.json(
        { error: error.message },
        sponsorshipHttpStatus(error),
      )
    }
    console.error(
      JSON.stringify({
        message: 'Unexpected sponsorship failure.',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    return c.json({ error: 'Unable to process sponsorship request.' }, 500)
  }

  const { metadata } = sponsorship
  if (sponsorship.kind === 'validated') {
    return c.json({
      dryRun: true,
      policy: metadata.policyName,
      moveCallTargets: metadata.moveCallTargets,
    })
  }

  // Cloudflare request metadata
  const cf = (c.req.raw as unknown as { cf?: Record<string, string> }).cf
  const rpcNode = SUI_GRPC_URL
  const userAgent = c.req.header('user-agent') ?? ''
  const ip = c.req.header('cf-connecting-ip') ?? ''
  const ipHash = ip
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : ''

  const outcome = sponsorship.outcome

  const analyticsBase = {
    dataset: ANALYTICS,
    sender: metadata.sender,
    policyName: metadata.policyName,
    rpcNode,
    cf,
    userAgent,
    ipHash,
    gasBudget: metadata.gasBudget,
    numMoveCalls: metadata.moveCallCount,
  }

  switch (outcome.kind) {
    case 'success':
    case 'chain_failed': {
      const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
      writeAnalytics({
        ...analyticsBase,
        epoch: tx?.epoch ?? '',
        digest: tx?.digest ?? '',
        success: outcome.result.$kind === 'Transaction',
        durationMs: outcome.durationMs,
        gasUsed: tx?.effects?.gasUsed,
      })
      return c.json(outcome.result)
    }

    case 'confirmation_timeout':
    case 'confirmation_error': {
      const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
      writeAnalytics({
        ...analyticsBase,
        epoch: tx?.epoch ?? '',
        digest: outcome.digest,
        success: false,
        durationMs: outcome.durationMs,
        gasUsed: tx?.effects?.gasUsed,
      })
      return c.json(
        {
          error: outcome.error,
          digest: outcome.digest,
          status: 'unconfirmed' as const,
        },
        outcome.kind === 'confirmation_timeout' ? 504 : 502,
      )
    }

    case 'execution_timeout':
    case 'execution_error': {
      writeAnalytics({
        ...analyticsBase,
        epoch: '',
        digest: '',
        success: false,
        durationMs: outcome.durationMs,
        gasUsed: undefined,
      })
      const httpStatus = outcome.kind === 'execution_timeout' ? 504 : 500
      return c.json({ error: outcome.error, status: 'unknown' as const }, httpStatus)
    }
  }
})

export default app
