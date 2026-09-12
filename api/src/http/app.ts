import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timing, startTime, endTime } from 'hono/timing'
import { z } from 'zod'
import {
  assertOnaraRuntimeReady,
  type OnaraRuntime,
} from '../core/runtime'
import {
  SponsorshipFailure,
  sponsorRequest,
  sponsorshipHttpStatus,
  type SponsorshipDependencies,
  type SponsorshipStage,
} from '../sponsorship-service'
import { isValidSuiAddress, toBase64 } from '@mysten/sui/utils'
import type { SuiClientTypes } from '@mysten/sui/client'
import { Schema } from 'effect'
import {
  DecodeError,
  Executed,
  ExecutionFailed,
} from '@unconfirmed/sui-effect'

const DEFAULT_EXECUTION_TIMEOUT_MS = 45_000
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30_000
const MAX_CALLER_TIMEOUT_MS = 60_000
const DEFAULT_READINESS_TIMEOUT_MS = 5_000

const STAGE_LABELS: Record<SponsorshipStage, string> = {
  guard: 'Gas budget cap',
  signature: 'Sender signature verification',
  context: 'Policy context resolution',
  policy: 'Policy validation',
  ownership: 'Owned input authorization',
  suins: 'SuiNS policy context',
  simulation: 'Transaction simulation',
  execution: 'Sign & execute transaction',
}

const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/
const sponsorPayloadSchema = z.object({
  sender: z.string().refine(isValidSuiAddress, 'Invalid Sui address.'),
  txBytes: z
    .string()
    .trim()
    .min(1, 'Missing base64 payload.')
    .regex(base64Regex, 'Invalid base64 payload.'),
  txSignature: z
    .string()
    .trim()
    .min(1, 'Missing base64 payload.')
    .regex(base64Regex, 'Invalid base64 payload.'),
})

const statusInclude = {
  effects: true,
  events: true,
  balanceChanges: true,
  objectTypes: true,
} as const

async function encodeTransactionResult(
  runtime: OnaraRuntime,
  result: SuiClientTypes.TransactionResult<typeof statusInclude>,
): Promise<Record<string, unknown>> {
  try {
    const executed = await runtime.effectRuntime.runPromise(
      Executed.fromTransactionResult(result),
    )
    return encodeExecutedJson(executed)
  } catch (error) {
    if (error instanceof ExecutionFailed) {
      const failure = encodeExecutionFailedJson(error)
      return {
        error: error.message,
        digest: error.digest,
        outcome: 'applied',
        failure,
      }
    }
    throw error
  }
}

function isTransactionNotFound(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (record._tag === 'TransactionNotFound') return true
    if (record.reason === 'notFound') return true
    if (record.status === 404 || record.code === 'NOT_FOUND' || record.code === 5) return true
  }
  return false
}

/** Encode the domain receipt into the JSON spellings accepted by Executed.fromPartial. */
function encodeExecutedJson(executed: Executed): Record<string, unknown> {
  const encoded = Schema.encodeUnknownSync(Executed)(executed) as Record<string, unknown>
  const events = Array.isArray(encoded.events)
    ? encoded.events.map((event) => {
        if (event === null || typeof event !== 'object') return event
        const value = event as Record<string, unknown>
        return value.bcs instanceof Uint8Array
          ? { ...value, bcs: toBase64(value.bcs) }
          : value
      })
    : encoded.events
  return { ...encoded, events }
}

function encodeExecutionFailedJson(error: ExecutionFailed): Record<string, unknown> {
  return Schema.encodeUnknownSync(ExecutionFailed)(error) as Record<string, unknown>
}

export function createOnaraApp(
  runtime: OnaraRuntime,
  { readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS }: {
    readinessTimeoutMs?: number
  } = {},
) {
  const app = new Hono()
  app.use(cors())
  app.use(timing())

  app.get('/livez', (c) => c.json({ status: 'live' }))

  app.get('/readyz', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const chainId = await assertOnaraRuntimeReady(runtime, {
        signal: AbortSignal.timeout(readinessTimeoutMs),
      })
      return c.json({
        status: 'ready',
        network: runtime.environment.SUI_NETWORK,
        chainId,
        policyDigest: runtime.policyDigest,
        policyVersion: runtime.policyVersion,
        engineVersion: runtime.engineVersion,
      })
    } catch (error) {
      logReadinessFailure(error)
      return c.json({ status: 'not-ready', outcome: 'not_applied' as const }, 503)
    }
  })

  app.get('/status', async (c) => {
    c.header('Cache-Control', 'no-store')
    startTime(c, 'init', 'Client & keypair init')
    endTime(c, 'init')

    try {
      startTime(c, 'rpc', 'Chain ID & balance fetch')
      const signal = AbortSignal.timeout(readinessTimeoutMs)
      const [chainId, balanceResult] = await Promise.all([
        assertOnaraRuntimeReady(runtime, { signal }),
        runtime.client.getBalance({ owner: runtime.sponsorAddress, signal }),
      ])
      endTime(c, 'rpc')
      return c.json({
        network: runtime.environment.SUI_NETWORK,
        chainId,
        address: runtime.sponsorAddress,
        policyDigest: runtime.policyDigest,
        policyVersion: runtime.policyVersion,
        engineVersion: runtime.engineVersion,
        balances: {
          active: balanceResult.balance.addressBalance,
          pending: balanceResult.balance.coinBalance,
        },
      })
    } catch (error) {
      logReadinessFailure(error)
      return c.json(
        { error: 'Onara is not ready.', outcome: 'not_applied' as const },
        503,
      )
    }
  })

  app.get('/sponsor/:digest/status', async (c) => {
    const digest = c.req.param('digest')
    try {
      const tx = await runtime.client.getTransaction({
        digest,
        include: statusInclude,
      })
      const encoded = await encodeTransactionResult(runtime, tx)
      return c.json({ found: true, ...encoded })
    } catch (error) {
      if (isTransactionNotFound(error)) {
        return c.json({ found: false, digest }, 404)
      }
      console.error(
        JSON.stringify({
          message: 'Unable to look up transaction status.',
          digest,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return c.json(
        {
          error: 'Unable to look up transaction status.',
          outcome: 'unknown' as const,
          digest,
        },
        503,
      )
    }
  })

  app.post('/sponsor', async (c) => {
    const waitForExecution = c.req.query('waitForExecution') !== 'false'
    const validateOnly = parseBool(c.req.query('dryRun'))
    let executionTimeoutMs: number
    let confirmationTimeoutMs: number
    try {
      executionTimeoutMs = resolveExecutionTimeout(
        runtime,
        c.req.query('executionTimeoutMs') ?? undefined,
      )
      confirmationTimeoutMs = resolveConfirmationTimeout(
        runtime,
        c.req.query('confirmationTimeoutMs') ?? undefined,
      )
    } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : 'Invalid sponsorship timeout configuration.',
            outcome: 'not_applied' as const,
          },
          400,
        )
    }

    let payload: unknown
    try {
      payload = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON.', outcome: 'not_applied' as const }, 400)
    }

    const parsed = sponsorPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? 'Invalid request payload.'
      return c.json({ error: issue, outcome: 'not_applied' as const }, 400)
    }

    startTime(c, 'init', 'Client & keypair init')
    const dependencies = sponsorshipDependenciesFor(runtime)
    endTime(c, 'init')

    let sponsorship
    try {
      sponsorship = await sponsorRequest({
        request: {
          payload: parsed.data,
          mode: validateOnly ? 'validate-only' : 'execute',
          waitForExecution,
          executionTimeoutMs,
          confirmationTimeoutMs,
        },
        dependencies,
        onStage: (stage, phase) => {
          if (phase === 'start') startTime(c, stage, STAGE_LABELS[stage])
          else endTime(c, stage)
        },
      })
    } catch (error) {
      if (error instanceof SponsorshipFailure) {
        return c.json(
          { error: error.message, outcome: 'not_applied' as const },
          sponsorshipHttpStatus(error),
        )
      }
      console.error(
        JSON.stringify({
          message: 'Unexpected sponsorship failure.',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return c.json(
        { error: 'Unable to process sponsorship request.', outcome: 'unknown' as const },
        500,
      )
    }

    const { metadata } = sponsorship
    if (sponsorship.kind === 'validated') {
      return c.json({
        dryRun: true,
        policy: metadata.policyName,
        moveCallTargets: metadata.moveCallTargets,
      })
    }

    const outcome = sponsorship.outcome
    switch (outcome.kind) {
      case 'success':
        return c.json(encodeExecutedJson(outcome.result))

      case 'chain_failed': {
        const encoded = encodeExecutionFailedJson(outcome.result)
        return c.json(
          {
            error: outcome.result.message,
            digest: outcome.result.digest,
            outcome: 'applied' as const,
            failure: encoded,
          },
          502,
        )
      }

      case 'submission_unknown': {
        return c.json(
          {
            error: outcome.error.message,
            digest: outcome.error.digest,
            status: 'unknown' as const,
            outcome: 'unknown' as const,
          },
          502,
        )
      }

      case 'not_applied': {
        return c.json(
          {
            error: outcome.error.message,
            outcome: 'not_applied' as const,
          },
          400,
        )
      }

      case 'execution_timeout': {
        return c.json(
          {
            error: outcome.error,
            ...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
            outcome: 'not_applied' as const,
          },
          504,
        )
      }

      case 'execution_error': {
        return c.json(
          {
            error: outcome.error,
            ...(outcome.digest === undefined ? {} : { digest: outcome.digest }),
            outcome: 'not_applied' as const,
          },
          500,
        )
      }
    }
  })

  return app
}

function logReadinessFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      message: 'Onara readiness check failed.',
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

function sponsorshipDependenciesFor(runtime: OnaraRuntime): SponsorshipDependencies {
  return {
    client: runtime.client,
    keypair: runtime.keypair,
    effectRuntime: runtime.effectRuntime,
    sponsorSigner: runtime.sponsorSigner,
    chainId: runtime.environment.SUI_CHAIN_ID,
    sponsorAddress: runtime.sponsorAddress,
    policies: runtime.policies,
    gasBudgetMax: runtime.gasBudgetMax,
    forceValidateOnly: runtime.forceValidateOnly,
  }
}

function resolveExecutionTimeout(runtime: OnaraRuntime, callerValue?: string): number {
  return resolveTimeout(
    runtime.environment.EXECUTION_TIMEOUT_MS,
    DEFAULT_EXECUTION_TIMEOUT_MS,
    'EXECUTION_TIMEOUT_MS',
    callerValue,
  )
}

function resolveConfirmationTimeout(runtime: OnaraRuntime, callerValue?: string): number {
  return resolveTimeout(
    runtime.environment.CONFIRMATION_TIMEOUT_MS,
    DEFAULT_CONFIRMATION_TIMEOUT_MS,
    'CONFIRMATION_TIMEOUT_MS',
    callerValue,
  )
}

function resolveTimeout(
  configuredValue: string | undefined,
  fallback: number,
  name: string,
  callerValue?: string,
): number {
  const serverMax = parseConfiguredTimeout(configuredValue, fallback, name)
  const caller = callerValue ? Number(callerValue) : undefined
  return caller && caller > 0 && caller <= MAX_CALLER_TIMEOUT_MS
    ? Math.min(caller, serverMax)
    : serverMax
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
