/**
 * Tests getChainIdentifier against a Sui gRPC endpoint.
 *
 * Usage:
 *   bun run scripts/test-chain-id.ts [grpc-url] [network]
 */

import { SuiGrpcClient } from '@mysten/sui/grpc'

const baseUrl = process.argv[2] ?? 'https://slc1.rpc.testnet.sui.mirai.cloud'
const network = process.argv[3] ?? 'testnet'

console.log(`Endpoint: ${baseUrl}`)
console.log(`Network:  ${network}`)
console.log()

const client = new SuiGrpcClient({ network, baseUrl })

try {
  const result = await client.core.getChainIdentifier()
  console.log('Chain identifier:', result.chainIdentifier)
} catch (err) {
  console.error('Failed:', err)
  process.exit(1)
}
