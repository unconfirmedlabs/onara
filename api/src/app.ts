import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timing, startTime, endTime } from 'hono/timing'
import { env } from 'hono/adapter'
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'
import pRetry from 'p-retry'
import {
  evaluatePolicyRequirements,
  loadPolicies,
  validateSponsoredTxPayload,
  type AuthorizationDecision,
  type PolicyEvaluationPlan,
} from './policy'
import {
  assertSenderControlsOwnedInputs,
  OwnedInputAuthorizationError,
} from './input-authorization'
import {
  checkDynamicAuthorization,
  DynamicAuthorizationDeniedError,
  type DynamicAuthorizationCache,
} from './dynamic-authorization'
import { executeTransaction, type OnStatus, type SponsorEvent } from './execution'
import { writeAnalytics } from './analytics'
import {
  assertGasBudgetWithinCap,
  assertRateLimits,
  GasBudgetExceededError,
  parseGasBudgetMax,
  RateLimitedError,
  type RateLimitBinding,
} from './request-guards'
import sponsorPoliciesConfig from '../policies'

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
  SUI_MNEMONIC: string
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

let _keypair: Ed25519Keypair | null = null
let _keypairKey = ''
let _sponsorAddress = ''

const getKeyPair = (mnemonic: string): Ed25519Keypair => {
  if (_keypair && _keypairKey === mnemonic) return _keypair
  _keypair = Ed25519Keypair.deriveKeypair(mnemonic)
  _keypairKey = mnemonic
  _sponsorAddress = _keypair.toSuiAddress()
  return _keypair
}

const getSponsorAddress = (mnemonic: string): string => {
  if (_sponsorAddress && _keypairKey === mnemonic) return _sponsorAddress
  getKeyPair(mnemonic)
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
  const serverMax = bindings.EXECUTION_TIMEOUT_MS ? Number(bindings.EXECUTION_TIMEOUT_MS) : DEFAULT_EXECUTION_TIMEOUT_MS
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function resolveConfirmationTimeout(bindings: Bindings, callerValue?: string): number {
  const serverMax = bindings.CONFIRMATION_TIMEOUT_MS ? Number(bindings.CONFIRMATION_TIMEOUT_MS) : DEFAULT_CONFIRMATION_TIMEOUT_MS
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS ? Math.min(caller, serverMax) : serverMax
}

function createGrpcClient(bindings: Bindings): SuiGrpcClient {
  if (!bindings.HAYABUSA) return getGrpcClient(bindings.SUI_NETWORK, bindings.SUI_GRPC_URL)
  // SuiGrpcClient silently drops a top-level `fetch` option (v2.5.0), so pass
  // the custom fetch via a pre-built GrpcWebFetchTransport instead.
  const transport = new GrpcWebFetchTransport({
    baseUrl: bindings.SUI_GRPC_URL,
    fetch: createPinningFetch(bindings.HAYABUSA),
  })
  return new SuiGrpcClient({ network: bindings.SUI_NETWORK, transport })
}

// Enforces the server-level GAS_BUDGET_MAX cap and the optional per-sender /
// per-IP rate limit bindings. Shared by the HTTP and WebSocket transports.
// Must run before policy matching, simulation, and signing.
async function guardRequest({
  bindings,
  txBytesBase64,
  sender,
  ip,
}: {
  bindings: Bindings
  txBytesBase64: string
  sender: string
  ip: string
}): Promise<void> {
  const gasBudgetMax = parseGasBudgetMax(bindings.GAS_BUDGET_MAX)
  const txData = Transaction.from(txBytesBase64).getData()
  assertGasBudgetWithinCap(txData.gasData.budget, gasBudgetMax)

  await assertRateLimits({
    senderLimiter: bindings.SENDER_RATE_LIMIT,
    ipLimiter: bindings.IP_RATE_LIMIT,
    sender: normalizeSuiAddress(sender),
    ip,
  })
}

// Shared by HTTP and WebSocket sponsorship. Every external check is signed for
// one exact (named requirement, concrete allow policy) tuple. Requirements are
// ANDed within a branch; all structurally matching allow branches are ORed.
async function evaluateAuthorizationPlan({
  bindings,
  plan,
  txBytesBase64,
}: {
  bindings: Bindings
  plan: PolicyEvaluationPlan
  txBytesBase64: string
}): Promise<AuthorizationDecision> {
  const txData = Transaction.from(txBytesBase64).getData()
  const sender = normalizeSuiAddress(txData.sender!)

  return evaluatePolicyRequirements({
    allowBranches: plan.allowBranches,
    evaluate: async ({ requirement, policyName }) => {
      try {
        await checkDynamicAuthorization({
          check: requirement.check,
          requirementName: requirement.name,
          policyName,
          sender,
          network: bindings.SUI_NETWORK,
          env: bindings as Record<string, unknown>,
          cache: bindings.DYNAMIC_AUTHORIZATION_CACHE,
        })
        return 'allow'
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'Dynamic authorization check failed.'
        console.error(
          JSON.stringify({
            message: 'Policy requirement check failed.',
            sender,
            requirement: requirement.name,
            policy: policyName,
            error: message,
          }),
        )
        return error instanceof DynamicAuthorizationDeniedError
          ? 'deny'
          : 'unavailable'
      }
    },
  })
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/status', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC, HAYABUSA } = env<Bindings>(c)

  startTime(c, 'init', 'Client & keypair init')
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL, HAYABUSA)
  const address = getSponsorAddress(SUI_MNEMONIC)
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

app.get('/policies', (c) => {
  return c.json(sponsorPoliciesConfig)
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
  const { DRY_RUN_ONLY, ANALYTICS, SUI_GRPC_URL } = bindings
  const parseBool = (v: string | undefined) => v === 'true' || v === '1'
  const waitForExecution = c.req.query('waitForExecution') !== 'false'
  const simulate = c.req.query('simulate') !== 'false'
  const dryRun = !!DRY_RUN_ONLY || parseBool(c.req.query('dryRun'))
  const executionTimeoutMs = resolveExecutionTimeout(bindings, c.req.query('executionTimeoutMs') ?? undefined)
  const confirmationTimeoutMs = resolveConfirmationTimeout(bindings, c.req.query('confirmationTimeoutMs') ?? undefined)

  const payload = (await c.req.json()) as {
    sender?: string
    txBytes?: string
    txSignature?: string
  }

  const parsed = sponsorPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]?.message ?? 'Invalid request payload.'
    return c.json({ error: issue }, 400)
  }

  // Server-level gas budget cap and per-sender/per-IP rate limits — enforced
  // before policy matching, simulation, and signing.
  startTime(c, 'guard', 'Gas budget cap & rate limiting')
  try {
    await guardRequest({
      bindings,
      txBytesBase64: parsed.data.txBytes,
      sender: parsed.data.sender,
      ip: c.req.header('cf-connecting-ip') ?? 'unknown',
    })
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return c.json({ error: error.message }, 429)
    }
    if (error instanceof GasBudgetExceededError) {
      return c.json({ error: error.message }, 400)
    }
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to validate sponsored transaction.'
    return c.json({ error: message }, 400)
  }
  endTime(c, 'guard')

  startTime(c, 'init', 'Client & keypair init')
  // Fresh client per request when hayabusa is bound — pinning fetch holds per-request
  // state to route follow-up reads to the same backend that saw the first response.
  const grpcClient = createGrpcClient(bindings)
  const keypair = getKeyPair(bindings.SUI_MNEMONIC)
  const sponsorAddress = getSponsorAddress(bindings.SUI_MNEMONIC)
  endTime(c, 'init')

  // Resolve SuiNS name only when a policy requires it
  startTime(c, 'suins', 'SuiNS resolution')
  const senderName = SPONSORED_POLICIES.needsSuinsResolution
    ? (await pRetry(
        () => grpcClient.core.defaultNameServiceName({ address: parsed.data.sender }),
        { retries: 1 },
      )).data.name
    : null
  endTime(c, 'suins')

  startTime(c, 'validate', 'Policy validation')
  let calledTargets: string[] = []
  let matchedPolicyName = ''
  let ownedInputIds: string[] = []
  let evaluationPlan: PolicyEvaluationPlan
  try {
    evaluationPlan = validateSponsoredTxPayload({
      txBytesBase64: parsed.data.txBytes,
      expectedSender: parsed.data.sender,
      expectedSponsor: sponsorAddress,
      policies: SPONSORED_POLICIES,
      senderName,
    })
    calledTargets = evaluationPlan.calledTargets
    ownedInputIds = evaluationPlan.ownedInputIds
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to validate sponsored transaction.'
    return c.json({ error: message }, 400)
  }
  endTime(c, 'validate')

  startTime(c, 'ownership', 'Owned input authorization')
  try {
    await assertSenderControlsOwnedInputs({
      client: grpcClient,
      sender: parsed.data.sender,
      objectIds: ownedInputIds,
    })
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to verify sponsored transaction object ownership.'
    return c.json(
      { error: message },
      error instanceof OwnedInputAuthorizationError ? 400 : 503,
    )
  }
  endTime(c, 'ownership')

  startTime(c, 'requirements', 'Policy requirement checks')
  const authorization = await evaluateAuthorizationPlan({
    bindings,
    plan: evaluationPlan,
    txBytesBase64: parsed.data.txBytes,
  })
  endTime(c, 'requirements')
  if (authorization.status === 'denied') {
    return c.json({ error: 'Transaction policy requirements denied.' }, 403)
  }
  if (authorization.status === 'unavailable') {
    return c.json({ error: 'Transaction policy requirements unavailable.' }, 503)
  }
  matchedPolicyName = authorization.policyName

  console.log(
    JSON.stringify({
      message: 'Sponsor request validated.',
      sender: parsed.data.sender,
      sponsor: sponsorAddress,
      policy: matchedPolicyName,
      moveCallTargets: calledTargets,
    }),
  )

  if (dryRun) {
    return c.json({ dryRun: true, policy: matchedPolicyName, moveCallTargets: calledTargets })
  }

  const txBytes = fromBase64(parsed.data.txBytes)

  // Parse transaction locally for analytics (gas budget, move call count)
  const txData = Transaction.from(parsed.data.txBytes).getData()
  const gasBudget = Number(txData.gasData.budget ?? 0)
  const numMoveCalls = txData.commands.filter((cmd) => cmd.$kind === 'MoveCall').length

  // Cloudflare request metadata
  const cf = (c.req.raw as unknown as { cf?: Record<string, string> }).cf
  const rpcNode = SUI_GRPC_URL
  const userAgent = c.req.header('user-agent') ?? ''
  const ip = c.req.header('cf-connecting-ip') ?? ''
  const ipHash = ip
    ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))))
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : ''

  if (simulate) {
    try {
      startTime(c, 'simulate', 'Transaction simulation')
      const simulation = await pRetry(
        () => grpcClient.simulateTransaction({ transaction: txBytes }),
        { retries: 1 },
      )
      endTime(c, 'simulate')
      if (simulation.$kind === 'FailedTransaction') {
        return c.json({ error: `Simulation failed: ${simulation.FailedTransaction.status.error ?? 'unknown error'}` }, 400)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.'
      return c.json({ error: decodeURIComponent(message) }, 400)
    }
  }

  startTime(c, 'execute', 'Sign & execute transaction')
  const outcome = await executeTransaction({
    grpcClient,
    keypair,
    txBytes,
    txSignature: parsed.data.txSignature,
    waitForExecution,
    executionTimeoutMs,
    confirmationTimeoutMs,
  })
  endTime(c, 'execute')

  const analyticsBase = {
    dataset: ANALYTICS,
    sender: parsed.data.sender,
    policyName: matchedPolicyName,
    rpcNode,
    cf,
    userAgent,
    ipHash,
    gasBudget,
    numMoveCalls,
  }

  switch (outcome.kind) {
    case 'success': {
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

    case 'confirmation_timeout': {
      const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
      writeAnalytics({
        ...analyticsBase,
        epoch: tx?.epoch ?? '',
        digest: outcome.digest,
        success: false,
        durationMs: outcome.durationMs,
        gasUsed: tx?.effects?.gasUsed,
      })
      return c.json({ error: outcome.error, digest: outcome.digest, status: 'unconfirmed' as const }, 504)
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

// ─── WebSocket sponsorship ────────────────────────────────────────────────────

app.get(
  '/sponsor/ws',
  upgradeWebSocket((c) => {
    const bindings = env<Bindings>(c)

    return {
      onMessage: async (evt, ws) => {
        const send = (event: SponsorEvent) => ws.send(JSON.stringify(event))

        let payload: unknown
        try {
          payload = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer))
        } catch {
          send({ status: 'error', error: 'Invalid JSON.' })
          ws.close(1008)
          return
        }

        send({ status: 'received' })

        const parsed = sponsorPayloadSchema.safeParse(payload)
        if (!parsed.success) {
          send({ status: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid request payload.' })
          ws.close(1008)
          return
        }

        // Server-level gas budget cap and per-sender/per-IP rate limits —
        // enforced before policy matching, simulation, and signing.
        try {
          await guardRequest({
            bindings,
            txBytesBase64: parsed.data.txBytes,
            sender: parsed.data.sender,
            ip: c.req.header('cf-connecting-ip') ?? 'unknown',
          })
        } catch (error) {
          send({
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Unable to validate sponsored transaction.',
          })
          ws.close(1008)
          return
        }

        const wsPayload = payload as Record<string, unknown>
        const simulate = wsPayload.simulate !== false
        const waitForExecution = wsPayload.waitForExecution !== false
        const executionTimeoutMs = resolveExecutionTimeout(bindings)
        const confirmationTimeoutMs = resolveConfirmationTimeout(bindings)

        const grpcClient = createGrpcClient(bindings)
        const keypair = getKeyPair(bindings.SUI_MNEMONIC)
        const sponsorAddress = getSponsorAddress(bindings.SUI_MNEMONIC)

        // SuiNS resolution
        let senderName: string | null = null
        if (SPONSORED_POLICIES.needsSuinsResolution) {
          try {
            senderName = (await pRetry(
              () => grpcClient.core.defaultNameServiceName({ address: parsed.data.sender }),
              { retries: 1 },
            )).data.name
          } catch (error) {
            send({ status: 'error', error: 'SuiNS resolution failed.' })
            ws.close(1011)
            return
          }
        }

        // Policy validation
        send({ status: 'validating' })
        let matchedPolicyName = ''
        let ownedInputIds: string[] = []
        let evaluationPlan: PolicyEvaluationPlan
        try {
          evaluationPlan = validateSponsoredTxPayload({
            txBytesBase64: parsed.data.txBytes,
            expectedSender: parsed.data.sender,
            expectedSponsor: sponsorAddress,
            policies: SPONSORED_POLICIES,
            senderName,
          })
          ownedInputIds = evaluationPlan.ownedInputIds
        } catch (error) {
          send({ status: 'error', error: error instanceof Error ? error.message : 'Policy validation failed.' })
          ws.close(1008)
          return
        }

        try {
          await assertSenderControlsOwnedInputs({
            client: grpcClient,
            sender: parsed.data.sender,
            objectIds: ownedInputIds,
          })
        } catch (error) {
          send({
            status: 'error',
            error:
              error instanceof Error
                ? error.message
                : 'Unable to verify sponsored transaction object ownership.',
          })
          ws.close(error instanceof OwnedInputAuthorizationError ? 1008 : 1011)
          return
        }

        const authorization = await evaluateAuthorizationPlan({
          bindings,
          plan: evaluationPlan,
          txBytesBase64: parsed.data.txBytes,
        })
        if (authorization.status === 'denied') {
          send({ status: 'error', error: 'Transaction policy requirements denied.' })
          ws.close(1008)
          return
        }
        if (authorization.status === 'unavailable') {
          send({ status: 'error', error: 'Transaction policy requirements unavailable.' })
          ws.close(1011)
          return
        }
        matchedPolicyName = authorization.policyName

        const txBytes = fromBase64(parsed.data.txBytes)

        // Simulation
        if (simulate) {
          send({ status: 'simulating' })
          try {
            const simulation = await pRetry(
              () => grpcClient.simulateTransaction({ transaction: txBytes }),
              { retries: 1 },
            )
            if (simulation.$kind === 'FailedTransaction') {
              send({ status: 'error', error: `Simulation failed: ${simulation.FailedTransaction.status.error ?? 'unknown error'}` })
              ws.close(1008)
              return
            }
          } catch (error) {
            send({ status: 'error', error: error instanceof Error ? error.message : 'Simulation failed.' })
            ws.close(1011)
            return
          }
        }

        // Analytics prep
        const txData = Transaction.from(parsed.data.txBytes).getData()
        const gasBudget = Number(txData.gasData.budget ?? 0)
        const numMoveCalls = txData.commands.filter((cmd) => cmd.$kind === 'MoveCall').length

        // Execution with status callbacks
        const outcome = await executeTransaction({
          grpcClient,
          keypair,
          txBytes,
          txSignature: parsed.data.txSignature,
          waitForExecution,
          executionTimeoutMs,
          confirmationTimeoutMs,
          onStatus: send,
        })

        const analyticsBase = {
          dataset: bindings.ANALYTICS,
          sender: parsed.data.sender,
          policyName: matchedPolicyName,
          rpcNode: bindings.SUI_GRPC_URL,
          cf: undefined,
          userAgent: '',
          ipHash: '',
          gasBudget,
          numMoveCalls,
        }

        switch (outcome.kind) {
          case 'success': {
            const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
            writeAnalytics({
              ...analyticsBase,
              epoch: tx?.epoch ?? '',
              digest: tx?.digest ?? '',
              success: outcome.result.$kind === 'Transaction',
              durationMs: outcome.durationMs,
              gasUsed: tx?.effects?.gasUsed,
            })
            // confirmed event already sent by executeTransaction via onStatus
            break
          }
          case 'confirmation_timeout': {
            const tx = outcome.result.$kind === 'Transaction' ? outcome.result.Transaction : outcome.result.FailedTransaction
            writeAnalytics({
              ...analyticsBase,
              epoch: tx?.epoch ?? '',
              digest: outcome.digest,
              success: false,
              durationMs: outcome.durationMs,
              gasUsed: tx?.effects?.gasUsed,
            })
            send({ status: 'error', error: outcome.error, digest: outcome.digest })
            break
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
            send({ status: 'error', error: outcome.error })
            break
          }
        }

        ws.close(1000)
      },

      onError: () => {},
    }
  }),
)

export default app
