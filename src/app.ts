import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { fromBase64, isValidSuiAddress } from '@mysten/sui/utils'
import sponsorPoliciesConfig from '../policies'
import { loadPolicies, validateSponsoredTxPayload } from './policy'

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
}

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
  return c.json({
    network: SUI_NETWORK,
    grpcUrl: SUI_GRPC_URL,
    address: getKeyPair(SUI_MNEMONIC).toSuiAddress(),
  })
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
  const waitForExecution = z.coerce.boolean().parse(c.req.query('waitForExecution') ?? 'false')
  const dryRun = z.coerce.boolean().parse(c.req.query('dryRun') ?? 'false')

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

  const result = await grpcClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: fromBase64(parsed.data.txBytes),
    additionalSignatures: [parsed.data.txSignature],
  });

  if (waitForExecution) {
    await grpcClient.waitForTransaction({ result })
  }

  return c.json(result)
})

export default app
