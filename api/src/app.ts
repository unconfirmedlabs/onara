import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { timing, startTime, endTime } from 'hono/timing'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, isValidSuiAddress } from '@mysten/sui/utils'
import pTimeout from 'p-timeout'
import pRetry from 'p-retry'
import { loadPolicies, validateSponsoredTxPayload } from './policy'
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
  ANALYTICS?: AnalyticsEngineDataset
  HAYABUSA?: { fetch: typeof fetch }
}

const DEFAULT_TIMEOUT_MS = 30_000

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
  _grpcClient = serviceBinding
    ? new SuiGrpcClient({ network, baseUrl, fetch: (input, init) => serviceBinding.fetch(input, init) })
    : new SuiGrpcClient({ network, baseUrl })
  _grpcClientKey = key
  return _grpcClient
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



app.post('/sponsor', async (c) => {
  const { DRY_RUN_ONLY, EXECUTION_TIMEOUT_MS, ANALYTICS, SUI_GRPC_URL } = env<Bindings>(c)
  const parseBool = (v: string | undefined) => v === 'true' || v === '1'
  const waitForExecution = c.req.query('waitForExecution') !== 'false'
  const dryRun = !!DRY_RUN_ONLY || parseBool(c.req.query('dryRun'))
  const serverExecutionTimeout = EXECUTION_TIMEOUT_MS ? Number(EXECUTION_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS
  const callerExecutionTimeout = c.req.query('executionTimeoutMs') ? Number(c.req.query('executionTimeoutMs')) : undefined
  const executionTimeoutMs = callerExecutionTimeout && callerExecutionTimeout > 0 && callerExecutionTimeout <= serverExecutionTimeout
    ? callerExecutionTimeout
    : serverExecutionTimeout

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

  const { SUI_NETWORK, SUI_MNEMONIC, HAYABUSA } = env<Bindings>(c)

  startTime(c, 'init', 'Client & keypair init')
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL, HAYABUSA)
  const keypair = getKeyPair(SUI_MNEMONIC)
  const sponsorAddress = getSponsorAddress(SUI_MNEMONIC)
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
  try {
    const validation = validateSponsoredTxPayload({
      txBytesBase64: parsed.data.txBytes,
      expectedSender: parsed.data.sender,
      expectedSponsor: sponsorAddress,
      policies: SPONSORED_POLICIES,
      senderName,
    })
    calledTargets = validation.calledTargets
    matchedPolicyName = validation.matchedPolicyName
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to validate sponsored transaction.'
    return c.json({ error: message }, 400)
  }
  endTime(c, 'validate')

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

  if (waitForExecution) {
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

  const execStart = Date.now()

  try {
    startTime(c, 'execute', 'Sign & execute transaction')
    const result = await pTimeout(
      pRetry(
        () => grpcClient.signAndExecuteTransaction({
          signer: keypair,
          transaction: txBytes,
          additionalSignatures: [parsed.data.txSignature],
          include: { effects: true },
        }),
        { retries: 1 },
      ),
      { milliseconds: executionTimeoutMs, message: 'Transaction execution timed out.' },
    )

    if (waitForExecution) {
      await pTimeout(
        grpcClient.waitForTransaction({ result }),
        { milliseconds: executionTimeoutMs, message: 'Transaction confirmation timed out.' },
      )
    }
    endTime(c, 'execute')

    const durationMs = Date.now() - execStart
    const tx = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
    const gasUsed = tx?.effects?.gasUsed

    ANALYTICS?.writeDataPoint({
      indexes: [parsed.data.sender],
      blobs: [
        parsed.data.sender,           // blob1:  sender
        tx?.epoch ?? '',               // blob2:  epoch
        matchedPolicyName,             // blob3:  policy name
        tx?.digest ?? '',              // blob4:  tx digest
        rpcNode,                       // blob5:  RPC node
        cf?.colo ?? '',                // blob6:  colo
        cf?.country ?? '',             // blob7:  country
        cf?.city ?? '',                // blob8:  city
        cf?.continent ?? '',           // blob9:  continent
        userAgent,                     // blob10: user agent
        ipHash,                        // blob11: ip hash (sha-256)
      ],
      doubles: [
        result.$kind === 'Transaction' ? 1.0 : 0.0, // double1: success
        1.0,                                          // double2: request count
        durationMs,                                   // double3: execution duration (ms)
        Number(gasUsed?.computationCost ?? 0),        // double4: computation cost
        Number(gasUsed?.storageCost ?? 0),             // double5: storage cost
        Number(gasUsed?.storageRebate ?? 0),           // double6: storage rebate
        gasBudget,                                     // double7: gas budget
        numMoveCalls,                                  // double8: num move calls
      ],
    })

    return c.json(result)
  } catch (error) {
    const durationMs = Date.now() - execStart

    ANALYTICS?.writeDataPoint({
      indexes: [parsed.data.sender],
      blobs: [
        parsed.data.sender,           // blob1:  sender
        '',                            // blob2:  epoch
        matchedPolicyName,             // blob3:  policy name
        '',                            // blob4:  tx digest
        rpcNode,                       // blob5:  RPC node
        cf?.colo ?? '',                // blob6:  colo
        cf?.country ?? '',             // blob7:  country
        cf?.city ?? '',                // blob8:  city
        cf?.continent ?? '',           // blob9:  continent
        userAgent,                     // blob10: user agent
        ipHash,                        // blob11: ip hash (sha-256)
      ],
      doubles: [
        0.0,                           // double1: success
        1.0,                           // double2: request count
        durationMs,                    // double3: execution duration (ms)
        0,                             // double4: computation cost
        0,                             // double5: storage cost
        0,                             // double6: storage rebate
        gasBudget,                     // double7: gas budget
        numMoveCalls,                  // double8: num move calls
      ],
    })

    const message = error instanceof Error ? error.message : 'Transaction execution failed.'
    return c.json({ error: message }, 500)
  }
})

export default app
