import { Hono } from 'hono'
import { cors } from 'hono/cors'
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
}

const DEFAULT_TIMEOUT_MS = 30_000

const app = new Hono()

app.use(cors())

const getGrpcClient = (network: string, baseUrl: string) =>
  new SuiGrpcClient({
    network,
    baseUrl,
  })

const getKeyPair = (mnemonic: string) =>
  Ed25519Keypair.deriveKeypair(mnemonic)

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
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const address = getKeyPair(SUI_MNEMONIC).toSuiAddress()
  let chainId: string | null = null
  let balances: { active: string; pending: string } | null = null
  try {
    const [chainResult, balanceResult] = await Promise.all([
      grpcClient.core.getChainIdentifier(),
      grpcClient.getBalance({ owner: address }),
    ])
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
  })
})

app.get('/policies', (c) => {
  return c.json(sponsorPoliciesConfig)
})

app.post('/refill', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = Ed25519Keypair.deriveKeypair(SUI_MNEMONIC)
  const address = keypair.toSuiAddress()

  const SUI_TYPE = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
  const coins: { objectId: string; balance: string }[] = []
  let cursor: string | null = null

  do {
    const page = await grpcClient.listCoins({ owner: address, coinType: SUI_TYPE, cursor })
    coins.push(...page.objects.map((coin) => ({ objectId: coin.objectId, balance: coin.balance })))
    cursor = page.hasNextPage ? page.cursor : null
  } while (cursor)

  if (coins.length === 0) {
    return c.json({ message: 'No coins to refill.', coins: 0 })
  }

  const tx = new Transaction()
  for (const coin of coins) {
    tx.moveCall({
      target: `${SUI_TYPE.split('::')[0]}::coin::send_funds`,
      arguments: [tx.object(coin.objectId), tx.pure.address(address)],
      typeArguments: [SUI_TYPE],
    })
  }

  const result = await grpcClient.signAndExecuteTransaction({ signer: keypair, transaction: tx })
  await grpcClient.waitForTransaction({ result })

  return c.json({ message: `Refilled ${coins.length} coin(s) to address balance.`, coins: coins.length, result })
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

  const { SUI_NETWORK, SUI_MNEMONIC } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = getKeyPair(SUI_MNEMONIC)
  const sponsorAddress = keypair.toSuiAddress()

  // Resolve SuiNS name only when a policy requires it
  const senderName = SPONSORED_POLICIES.needsSuinsResolution
    ? (await pRetry(
        () => grpcClient.core.defaultNameServiceName({ address: parsed.data.sender }),
        { retries: 1 },
      )).data.name
    : null

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
  const rpcNode = SUI_GRPC_URL.replace(/^https?:\/\//, '')
  const userAgent = c.req.header('user-agent') ?? ''

  if (waitForExecution) {
    try {
      const simulation = await pRetry(
        () => grpcClient.simulateTransaction({ transaction: txBytes }),
        { retries: 1 },
      )
      if (simulation.$kind === 'FailedTransaction') {
        return c.json({ error: `Simulation failed: ${simulation.FailedTransaction.status.error ?? 'unknown error'}` }, 400)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.'
      return c.json({ error: decodeURIComponent(message) }, 400)
    }
  }

  const startTime = Date.now()

  try {
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

    const durationMs = Date.now() - startTime
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
    const durationMs = Date.now() - startTime

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
