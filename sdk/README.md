# @unconfirmed/onara

TypeScript client SDK for [Onara](https://github.com/unconfirmedlabs/onara) — a policy-based Sui transaction sponsorship (gas station) server.

## Install

```bash
bun add @unconfirmed/onara @mysten/sui
```

`@mysten/sui` is a peer dependency — the SDK uses whichever copy your app installs.

## Usage

### As a Sui client extension (recommended)

Register Onara on a Sui client with `$extend`, following the Mysten SDK extension pattern. The registered client is reused to build transactions, so you don't pass it again:

```typescript
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { onara } from '@unconfirmed/onara'

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' })
  .$extend(onara({ url: 'https://my-onara.example.com' }))

// Sponsor a transaction — built, signed, and submitted for you
const result = await client.onara.sponsorTransaction({ transaction: tx, signer: keypair })

// Inspect the sponsor
const { address, balances } = await client.onara.status()
```

### As a standalone client

```typescript
import { OnaraClient } from '@unconfirmed/onara'

const onara = new OnaraClient('https://my-onara.example.com')

// Check sponsor status & view configured policies
const { address, balances } = await onara.status()
const policies = await onara.policies()

// High-level: build, sign, and sponsor (pass the Sui client used to build)
const result = await onara.sponsorTransaction({
  transaction: tx,
  signer: keypair,
  client: suiClient,
})

// Low-level: sponsor pre-built bytes
const result = await onara.sponsor({
  sender: '0x...',
  txBytes: '...',
  txSignature: '...',
  dryRun: true,
})
```

## API

### `onara(options)`

Returns a Sui client extension for `client.$extend(...)`. Registers an `OnaraClient` under `client.onara` (or a custom `name`).

- `url` — base URL of the Onara server
- `name?` — property to register under (default `'onara'`)
- `fetch?` — custom `fetch` implementation

### `new OnaraClient(url)` / `new OnaraClient({ url, fetch?, client? })`

Create a client directly. `fetch` injects a custom fetch (useful for testing); `client` sets a default Sui client for `sponsorTransaction` (set automatically when registered via `onara()`).

### `client.status()`

Returns the server's network, chain identifier, sponsor address, and balances.

### `client.policies()`

Returns the typed array of configured schema-v1 policies. `PolicyConfig` is a
discriminated union of reusable `require` policies, absolute `deny` policies,
and independent `allow` authorization branches:

```typescript
import type { PolicyConfig } from '@unconfirmed/onara'

const policies: PolicyConfig[] = await onara.policies()
for (const policy of policies) {
  if (policy.type === 'allow') {
    console.log(policy.name, policy.requires)
  }
}
```

Every allow policy explicitly declares `requires`; `[]` is an intentional
public branch. Gas budgets are positive decimal strings so they remain
bigint-safe in JavaScript.

Result-flow constraints identify both ends precisely: `from.result` is the
producer's zero-based result slot, while each `to.argument` is the consumer's
zero-based top-level Move-call argument. For example:

```typescript
{
  from: { rule: 'withdraw', result: 0 },
  to: [{ rule: 'send', argument: 0 }],
}
```

The server applies the constraint to every occurrence of the producer rule. By
default the selected slot needs at least one use, and every use must be the
specified top-level Move-call rule/argument. A native-command use, different
Move-call use, wrong tuple slot, or missing required use is rejected.

### `client.sponsor(options)`

Submit pre-built transaction bytes for sponsorship.

- `sender` — Sui address of the transaction sender
- `txBytes` — base64-encoded transaction bytes
- `txSignature` — base64-encoded sender signature
- `dryRun?` — validate against policies without submitting
- `waitForExecution?` — wait for transaction finality (default `true`)
- `simulate?` — run pre-flight simulation before execution (default `true`)

On a confirmation timeout the thrown `OnaraError` carries `digest` and `txStatus: 'unconfirmed'`; use `getTransactionStatus(digest)` to resolve the final outcome.

### `client.sponsorTransaction(options)`

High-level convenience that builds, signs, and sponsors a transaction.

- `transaction` — a Sui `Transaction` instance
- `signer` — a Sui `Signer` (e.g. `Ed25519Keypair`)
- `client?` — a Sui client used to build the transaction (defaults to the registered/constructed client)
- `dryRun?`, `waitForExecution?`, `simulate?` — as in `sponsor`

### `client.getTransactionStatus(digest)`

Look up the on-chain status of a sponsored transaction by digest — useful for recovering after a confirmation timeout.
