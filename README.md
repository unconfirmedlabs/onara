# Onara

Policy-enforced gas sponsorship for Sui.

Onara lets an application pay transaction gas without giving up control over
what it will sponsor. Clients build and sign their own transactions. The Onara
Worker verifies the sender, gas owner, object ownership, transaction shape, and
every configured authorization requirement before it adds the sponsor signature
and submits the transaction to Sui.

- **Declarative policies.** Define reusable requirements, absolute denials, and
  exact allow branches in one versioned JSON configuration.
- **Fail-closed authorization.** A transaction must satisfy a complete allow
  branch, and any matching deny policy wins.
- **Sender-aware sponsorship.** Dynamic authorization requirements call an
  external authorizer with a domain-separated request signed by a dedicated
  Sui identity.
- **Sui SDK integration.** Use the published TypeScript client directly or as a
  native Sui client extension.
- **Cloudflare-native operation.** The server runs on Workers with optional KV,
  Analytics Engine, and rate-limiting bindings.

Documentation: [unconfirmed.com/projects/onara](https://unconfirmed.com/projects/onara)

## Repository

| Path | Purpose |
|---|---|
| [`api/`](./api) | Hono service, schema-v1 policy engine, Cloudflare Worker entry point, deployment tooling, and security tests |
| [`sdk/`](./sdk) | Source for the published [`@unconfirmed/onara`](https://www.npmjs.com/package/@unconfirmed/onara) TypeScript package |

Both packages share the root Bun lockfile and are developed in this repository.
SDK releases are published from `sdk-v*` tags using npm trusted publishing.

## Use the SDK

```bash
bun add @unconfirmed/onara @mysten/sui
```

Register Onara as a Sui client extension:

```ts
import { onara } from '@unconfirmed/onara'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { Transaction } from '@mysten/sui/transactions'

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
}).$extend(onara({ url: 'https://onara.example.com' }))

const signer = new Ed25519Keypair()
const transaction = new Transaction()

// Add only calls that the deployment's policy allows.
transaction.moveCall({ target: '0xPACKAGE::module::function' })

const result = await client.onara.sponsorTransaction({
  transaction,
  signer,
})
```

The extension fetches the sponsor address, sets the transaction sender and gas
owner, builds with the registered Sui client, collects the sender signature, and
submits the sponsorship request. The sender's key never leaves the client.

See [`sdk/README.md`](./sdk/README.md) for the standalone client, dry runs,
policy inspection, transaction status recovery, and the full typed API.

## Policy model

An Onara deployment has one authoritative `config.json`:

```jsonc
{
  "version": 1,
  "wrangler": {
    "name": "my-onara-testnet",
    "main": "src/workers.ts",
    "compatibility_date": "2026-02-26",
    "vars": {
      "SUI_NETWORK": "testnet",
      "SUI_GRPC_URL": "https://fullnode.testnet.sui.io:443"
    }
  },
  "policies": [
    {
      "type": "require",
      "name": "known-user",
      "check": {
        "kind": "dynamic-authorization",
        "url": "https://api.example.com/v1/onara/authorize",
        "audience": "example-onara-authorization",
        "timeoutMs": 1500,
        "cacheTtlSeconds": 0
      }
    },
    {
      "type": "deny",
      "name": "blocked-call",
      "when": {
        "kind": "any-move-call",
        "targets": ["0x2::coin::destroy_zero"]
      }
    },
    {
      "type": "allow",
      "name": "create-example",
      "requires": ["known-user"],
      "gasBudgetMax": "1000000000",
      "commands": { "allowed": ["MoveCall"], "max": 1 },
      "calls": {
        "mode": "sequence",
        "rules": [
          {
            "id": "create",
            "targets": ["0xPACKAGE::module::function"],
            "count": { "min": 1, "max": 1 }
          }
        ]
      }
    }
  ]
}
```

The policy algebra is:

```text
deny override; OR(allows); AND(requirements)
```

- `require` defines a reusable external authorization check. Schema v1 supports
  `dynamic-authorization`.
- `deny` rejects an absolute or structurally matched transaction before allows
  are considered.
- `allow` defines one complete transaction-shape branch. Its `requires` field is
  mandatory; an empty array is an intentionally public branch.

Policies can constrain command kinds and counts, Move call targets, type
arguments, ordering, and the exact flow of command results into later call
arguments. Unknown fields, ambiguous rules, duplicate names, and incomplete
branches are rejected when configuration loads.

## Security boundary

Policy matching is only one layer. Before Onara simulates or signs, it also
requires that:

1. the embedded transaction sender equals the requesting sender;
2. the gas owner equals the configured sponsor;
3. balance withdrawals belong to the sender, never the sponsor;
4. commands do not reference `GasCoin`; and
5. every owned object input is sender-owned or immutable.

Dynamic authorization requests are signed by the sponsor key configured in
`SUI_PRIVATE_KEY`. Onara derives its public address for `X-Onara-Identity`, so
policies contain neither private key material nor a redundant signer address.
Receivers must independently trust the sponsor address.

See [`api/README.md`](./api/README.md) for the complete schema, request signing
format, endpoint contract, rate limits, bindings, and operational details.

## Run locally

Requirements: [Bun](https://bun.sh), a Sui RPC endpoint, and Wrangler for local
Worker development.

```bash
bun install --frozen-lockfile

bun run --cwd api typecheck
bun run --cwd api test

bun run --cwd sdk build
bun run --cwd sdk test
```

Start the Worker locally:

```bash
bun run --cwd api dev
```

## Deploy

Keep environment-specific configuration outside the engine repository, then
pass its directory to the deployment script:

```bash
cd api
wrangler secret put SUI_PRIVATE_KEY
bun run deploy --config /path/to/environment
```

The deploy command validates the unified configuration and complete policy set
before generating temporary Wrangler artifacts. The sponsor address and dynamic
authorization identity are both derived from `SUI_PRIVATE_KEY` at runtime.

## HTTP surface

| Endpoint | Purpose |
|---|---|
| `GET /status` | Network, chain ID, sponsor address, and sponsor balances |
| `GET /policies` | Active schema-v1 policy configuration |
| `POST /sponsor` | Validate, optionally simulate, sponsor, and execute a signed transaction |
| `GET /sponsor/:digest/status` | Recover transaction status after an uncertain confirmation |

## License

[Apache-2.0](./LICENSE)
