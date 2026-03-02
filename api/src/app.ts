import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, isValidSuiAddress } from '@mysten/sui/utils'
import pTimeout from 'p-timeout'
import sponsorPoliciesConfig from '../policies'
import { loadPolicies, validateSponsoredTxPayload } from './policy'

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  DRY_RUN_ONLY?: string
  EXECUTION_TIMEOUT_MS?: string
}

const DEFAULT_TIMEOUT_MS = 30_000

const app = new Hono()

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
  let chainId: string | null = null
  try {
    const result = await grpcClient.core.getChainIdentifier()
    chainId = result.chainIdentifier
  } catch {}
  return c.json({
    network: SUI_NETWORK,
    chainId,
    address: getKeyPair(SUI_MNEMONIC).toSuiAddress(),
  })
})

app.get('/policies', (c) => {
  return c.json(sponsorPoliciesConfig)
})

app.get('/refill/:coinId', async (c) => {
  const coinId = c.req.param('coinId')

  if (!coinId) {
    return c.json({ error: 'Missing coinId parameter.' }, 400)

  }
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = Ed25519Keypair.deriveKeypair(SUI_MNEMONIC)
  const tx = new Transaction()
  tx.moveCall({
    target: '0x0000000000000000000000000000000000000000000000000000000000000002::coin::send_funds',
    arguments: [tx.object(coinId), tx.pure.address(keypair.toSuiAddress())],
    typeArguments: ['0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI']
  })
  const result = await grpcClient.signAndExecuteTransaction({ signer: keypair, transaction: tx })
  return c.json(result)
})

app.post('/sponsor', async (c) => {
  const { DRY_RUN_ONLY, EXECUTION_TIMEOUT_MS } = env<Bindings>(c)
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

  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = getKeyPair(SUI_MNEMONIC)
  const sponsorAddress = keypair.toSuiAddress()
  let calledTargets: string[] = []
  let matchedPolicyName = ''

  try {
    const validation = validateSponsoredTxPayload({
      txBytesBase64: parsed.data.txBytes,
      expectedSender: parsed.data.sender,
      expectedSponsor: sponsorAddress,
      policies: SPONSORED_POLICIES,
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

  if (waitForExecution) {
    try {
      const simulation = await grpcClient.simulateTransaction({ transaction: txBytes })
      if (simulation.$kind === 'FailedTransaction') {
        return c.json({ error: `Simulation failed: ${simulation.FailedTransaction.status.error ?? 'unknown error'}` }, 400)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Simulation failed.'
      return c.json({ error: decodeURIComponent(message) }, 400)
    }
  }

  try {
    const result = await pTimeout(
      grpcClient.signAndExecuteTransaction({
        signer: keypair,
        transaction: txBytes,
        additionalSignatures: [parsed.data.txSignature],
      }),
      { milliseconds: executionTimeoutMs, message: 'Transaction execution timed out.' },
    )

    if (waitForExecution) {
      await pTimeout(
        grpcClient.waitForTransaction({ result }),
        { milliseconds: executionTimeoutMs, message: 'Transaction confirmation timed out.' },
      )
    }

    return c.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transaction execution failed.'
    return c.json({ error: message }, 500)
  }
})

export default app
