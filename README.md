# Onara

Policy-enforced gas sponsorship for Sui.

Onara lets an application pay transaction gas without giving up control over
what it will sponsor. Clients build and sign their own transactions. The Onara
service verifies the sender, gas owner, object ownership, and transaction shape
before it adds the sponsor signature and submits the transaction to Sui.

- **Declarative policies.** Define absolute denials and exact allow branches in
  one versioned JSON configuration.
- **Fail-closed authorization.** A transaction must satisfy a complete allow
  branch, and any matching deny policy wins.
- **Clear authorization boundary.** User authorization and abuse controls live
  at the trusted edge or proxy, outside the sponsorship service.
- **Sui SDK integration.** Use the published TypeScript client directly or as a
  native Sui client extension.
- **Portable server adapters.** Cloudflare Workers and Bun are peer adapters.

Documentation: [unconfirmed.com/projects/onara](https://unconfirmed.com/projects/onara)

## Repository

| Path | Purpose |
|---|---|
| [`api/`](./api) | Host-neutral sponsorship service and HTTP app, Cloudflare and Bun adapters, deployment tooling, and security tests |
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
owner, forces an empty gas payment so only the sponsor's address balance can be
used, builds with the registered Sui client, collects the sender signature, and
submits the sponsorship request. The sender's key never leaves the client.

See [`sdk/README.md`](./sdk/README.md) for the standalone client, dry runs,
transaction status recovery, and the full typed API.

## Policy model

An Onara deployment has one authoritative `config.json`:

```jsonc
{
  "version": 1,
  "policies": [
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
deny override; OR(allows)
```

- `deny` rejects an absolute or structurally matched transaction before allows
  are considered.
- `allow` defines one complete transaction-shape branch.

Policies can constrain command kinds and counts, Move call targets, type
arguments, ordering, and the exact flow of command results into later call
arguments. Unknown fields, ambiguous rules, duplicate names, and incomplete
branches are rejected when configuration loads.

## Security boundary

Policy matching is only one layer. Before Onara simulates or signs, it also
requires that:

1. the sender's signature is valid for the exact transaction bytes;
2. the embedded transaction sender equals the requesting sender and is not the sponsor;
3. the gas owner equals the configured sponsor;
4. the gas payment is empty, so gas comes only from the sponsor's address balance;
5. the transaction expires no later than the next epoch;
6. balance withdrawals belong to the sender, never the sponsor;
7. commands do not reference `GasCoin`; and
8. every owned object input is sender-owned or immutable; and
9. every enabled allow path has a configured global or per-policy gas ceiling.

Simulation is mandatory before co-signing, so a caller cannot make the sponsor
pay for a transaction that already fails in pre-flight checks.

See [`api/README.md`](./api/README.md) for the complete schema, request signing
format, endpoint contract, and operational details.

## Run locally

Requirements: [Bun](https://bun.sh) and a Sui RPC endpoint. Wrangler is also
required when using the Cloudflare adapter.

```bash
bun install --frozen-lockfile

bun run --cwd api typecheck
bun run --cwd api test

bun run --cwd sdk build
bun run --cwd sdk test
```

Start either adapter locally:

```bash
bun run --cwd api dev:cloudflare
# or
bun run --cwd api start:bun
```

## Deploy

Keep host-neutral policy configuration outside the engine repository. For
Cloudflare, place `config.json` (policies) and `wrangler.jsonc` (deployment
settings) together, then deploy with the Cloudflare adapter:

```bash
cd api
wrangler secret put SUI_PRIVATE_KEY
bun run deploy:cloudflare --config /path/to/environment
```

The Cloudflare deploy command validates the policy configuration before
generating a temporary Worker policy registry. The Bun adapter is deployed as
a standard Bun process and requires the same policy file through
`ONARA_CONFIG_PATH`.

## HTTP surface

| Endpoint | Purpose |
|---|---|
| `GET /livez` | Process liveness; no RPC call |
| `GET /readyz` | Time-bounded RPC and chain-identity readiness |
| `GET /status` | Network, chain ID, sponsor address, and sponsor balances |
| `POST /sponsor` | Validate, simulate, sponsor, and execute a signed transaction |
| `GET /sponsor/:digest/status` | Recover transaction status after an uncertain confirmation |

## License

[Apache-2.0](./LICENSE)
