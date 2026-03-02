/**
 * Builds a coin::zero → coin::destroy_zero transaction, sponsors it, and
 * executes it on-chain.
 *
 * Usage:
 *   bun run scripts/test-sponsor.ts [onara-url] [rpc-url]
 *
 * Defaults:
 *   onara-url  http://localhost:3000
 *   rpc-url    SUI_GRPC_URL from env, or https://slc1.rpc.testnet.sui.mirai.cloud
 */

import { Transaction } from '@mysten/sui/transactions'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { toBase64 } from '@mysten/sui/utils'

const SUI_PKG = '0x0000000000000000000000000000000000000000000000000000000000000002'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')))
const baseUrl = args[0] ?? 'http://localhost:3000'
const rpcUrl = args[1] ?? process.env.SUI_GRPC_URL ?? 'https://slc1.rpc.testnet.sui.mirai.cloud'

// 1. Fetch sponsor address
const statusRes = await fetch(`${baseUrl}/status`)
if (!statusRes.ok) {
  console.error(`Failed to fetch /status: ${statusRes.status}`)
  process.exit(1)
}
const status = (await statusRes.json()) as { network: string; address: string }
console.log(`Network:  ${status.network}`)
console.log(`Sponsor:  ${status.address}`)
console.log(`RPC:      ${rpcUrl}`)

// 2. Set up sender + Sui client
const sender = new Ed25519Keypair()
console.log(`Sender:   ${sender.toSuiAddress()}`)

const suiClient = new SuiGrpcClient({ network: status.network, baseUrl: rpcUrl })

// 3. Build tx: coin::zero<SUI> → coin::destroy_zero<SUI>
const tx = new Transaction()
const coin = tx.moveCall({
  target: `${SUI_PKG}::coin::zero`,
  typeArguments: [`${SUI_PKG}::sui::SUI`],
})
tx.moveCall({
  target: `${SUI_PKG}::coin::destroy_zero`,
  arguments: [coin],
  typeArguments: [`${SUI_PKG}::sui::SUI`],
})

tx.setSender(sender.toSuiAddress())
tx.setGasOwner(status.address)

const bytes = await tx.build({ client: suiClient })
const { signature } = await sender.signTransaction(bytes)

// 4. Print curl or execute
const body = {
  sender: sender.toSuiAddress(),
  txBytes: toBase64(bytes),
  txSignature: signature,
}

if (flags.has('--curl')) {
  const json = JSON.stringify(body)
  console.log(`\ncurl -X POST '${baseUrl}/sponsor' \\`)
  console.log(`  -H 'Content-Type: application/json' \\`)
  console.log(`  -d '${json}'`)
  process.exit(0)
}

console.log(`\nPOST ${baseUrl}/sponsor`)

const res = await fetch(`${baseUrl}/sponsor`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

const result = await res.json()
console.log(`\nResponse (${res.status}):`)
console.log(JSON.stringify(result, null, 2))

process.exit(res.ok ? 0 : 1)
