import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, isValidSuiAddress, toBase64 } from '@mysten/sui/utils';

type Bindings = {
  SUI_GRPC_URL: string
  SUI_NETWORK: string
  SUI_MNEMONIC: string
  SUI_MNEMONIC_MOCK: string
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

const buildSponsoredTxBytes = async ({
  client,
  txKindBytesBase64,
  sender,
  sponsorAddress,
}: {
  client: SuiGrpcClient
  txKindBytesBase64: string
  sender: string
  sponsorAddress: string
}) => {
  const sponsoredTx = Transaction.fromKind(txKindBytesBase64)
  sponsoredTx.setSender(sender)
  sponsoredTx.setGasOwner(sponsorAddress)
  return sponsoredTx.build({ client })
}

app.get('/status', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC } = env<Bindings>(c)
  return c.json({
    network: SUI_NETWORK,
    grpcUrl: SUI_GRPC_URL,
    address: getKeyPair(SUI_MNEMONIC).toSuiAddress(),
  })
})

app.get('/refill', async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC_MOCK } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = Ed25519Keypair.deriveKeypair(SUI_MNEMONIC_MOCK)
  const tx = new Transaction()
  tx.moveCall({
    target: '0x2::coin::send_funds',
    arguments: [tx.gas, tx.pure.address(keypair.toSuiAddress())],
    typeArguments: ['0x2::sui::SUI']
  })
  const result = await grpcClient.signAndExecuteTransaction({ signer: keypair, transaction: tx })
  return c.json(result)
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
    target: '0x2::coin::send_funds',
    arguments: [tx.object(coinId), tx.pure.address(keypair.toSuiAddress())],
    typeArguments: ['0x2::sui::SUI']
  })
  const result = await grpcClient.signAndExecuteTransaction({ signer: keypair, transaction: tx })
  return c.json(result)
})

app.get("/mock", async (c) => {
  const { SUI_NETWORK, SUI_GRPC_URL, SUI_MNEMONIC, SUI_MNEMONIC_MOCK } = env<Bindings>(c)
  const grpcClient = getGrpcClient(SUI_NETWORK, SUI_GRPC_URL)
  const keypair = getKeyPair(SUI_MNEMONIC)
  const mockKeypair = Ed25519Keypair.deriveKeypair(SUI_MNEMONIC_MOCK)
  const tx = new Transaction()
  const coin = tx.moveCall({
    target: '0x2::coin::zero',
    arguments: [],
    typeArguments: ['0x2::sui::SUI']
  })
  tx.moveCall(
    {
      target: '0x2::coin::destroy_zero',
      arguments: [coin],
      typeArguments: ['0x2::sui::SUI']
    }
  )
  const kindBytes = await tx.build({ client: grpcClient, onlyTransactionKind: true });
  const txBytes = await buildSponsoredTxBytes({
    client: grpcClient,
    txKindBytesBase64: toBase64(kindBytes),
    sender: mockKeypair.toSuiAddress(),
    sponsorAddress: keypair.toSuiAddress(),
  })
  const senderSignature = await mockKeypair.signTransaction(txBytes)
  const payload = {
    sender: mockKeypair.toSuiAddress(),
    txBytes: toBase64(txBytes),
    txSignature: senderSignature.signature,
  }
  return c.json(payload)
})

app.post('/sponsor', async (c) => {
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
  const result = await grpcClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: fromBase64(parsed.data.txBytes),
    additionalSignatures: [parsed.data.txSignature],
  });

  return c.json(result)
})

export default app
