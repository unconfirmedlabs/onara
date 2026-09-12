# @unconfirmed/onara

TypeScript client SDK for [Onara](https://github.com/unconfirmedlabs/onara) — a policy-based Sui transaction sponsorship (gas station) server.

## Install

```bash
bun add @unconfirmed/onara @mysten/bcs@2.1.1 @mysten/sui@2.30.0 @unconfirmed/sui-effect@^0.1.2 effect@4.0.0-rc.112
```

`@mysten/bcs`, `@mysten/sui`, `effect`, and `@unconfirmed/sui-effect` are peer
dependencies. Install one compatible copy of each in the application.

## Usage

### As a Sui client extension (recommended)

Register Onara on a Sui client with `$extend`, following the Mysten SDK
extension pattern. The registered client supplies the Sui runtime used to
build and submit transactions:

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

The extension is backed by the `Onara` Effect service. Applications that use
Effect directly can provide the service layer instead:

```typescript
import { Effect } from 'effect'
import { Onara } from '@unconfirmed/onara'

const status = Effect.gen(function* () {
  const service = yield* Onara
  return yield* service.status
})
// Compose Onara.layer with the application's Sui layer before running `status`.
```

There is no URL-only `new OnaraClient(...)` constructor in this release. A
standalone HTTP client would not have the Sui runtime needed for the high-level
transaction path. Use `$extend` for Promise consumers or `Onara.layer` for an
Effect application; this is the Effect migration boundary.

## API

### `onara(options)`

Returns a Sui client extension for `client.$extend(...)`. Registers the
Promise face of the `Onara` service under `client.onara` (or a custom `name`).

- `url` — base URL of the Onara server
- `name?` — property to register under (default `'onara'`)
- `fetch?` — custom `fetch` implementation

### `client.onara.status()`

Returns the server's network, chain identifier, sponsor address, balances,
`policyDigest` (`sha256:` plus 64 lowercase hex characters), `policyVersion`
(configuration schema version), and `engineVersion` (API package version).
The digest fingerprints the complete canonical policy configuration; it
does not include environment settings or engine code. Compute the expected
value locally with `onara policy-digest config.json` using the API package's
Bun CLI. The server does not expose the policies themselves.

### Policy configuration types

For local configuration tooling, the SDK exports `PolicyConfig`, a
discriminated union of absolute `deny` policies and independent structural
`allow` branches. The server intentionally does not expose its active policy
configuration over HTTP.

```typescript
import type { PolicyConfig } from '@unconfirmed/onara'

const policies: PolicyConfig[] = [/* local deployment policies */]
```

Gas budgets are positive decimal strings so they remain bigint-safe in
JavaScript. User authorization and abuse controls belong at the trusted edge
or proxy in front of the sponsorship service.

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

### `client.onara.sponsor(options)`

Submit pre-built transaction bytes for sponsorship.

- `sender` — Sui address of the transaction sender
- `txBytes` — base64-encoded transaction bytes
- `txSignature` — base64-encoded sender signature
- `dryRun?` — validate against policies without submitting
- `waitForExecution?` — wait for indexed transaction visibility (default `true`)

The server always verifies the sender signature and simulates before sponsor
signing. Simulation cannot be disabled by a caller.

The transaction must set the Onara sponsor as gas owner and use an empty gas
payment (`transaction.setGasPayment([])`). Explicit gas coin payments are
rejected; Onara sponsors exclusively from the sponsor's address balance. It
must also carry an epoch expiration no later than the next epoch.

The error outcome is explicit: `not_applied` means the server refused the
request before submission, `unknown` means submission may have reached Sui, and
`applied` carries a terminal on-chain failure. An ambiguous submission raises
`SubmissionUnknown` with the local digest and signed bytes; use
`client.onara.getTransactionStatus(digest)` to recover it. A chain transaction
that executes and then fails raises `ExecutionFailed` and is already terminal.

The `simulate` option remains accepted for source compatibility and is ignored;
server simulation is always required.

### `client.onara.sponsorTransaction(options)`

High-level convenience that builds, signs, and sponsors a transaction.

This helper sets `gasPayment` to `[]` before building, so the Sui resolver
cannot fall back to sponsor-owned coin objects. The resolver also supplies the
bounded `ValidDuring` expiration required for address-balance transactions.

- `transaction` — a composable `Recipe` or a Sui `Transaction` instance
- `signer` — an Effect `Signer`, or a Sui `Signer` such as `Ed25519Keypair`
- `client?` — an optional Sui client used to build the transaction (defaults to the registered client)
- `dryRun?`, `waitForExecution?` — as in `sponsor`

The helper overwrites gas payment with `[]`, derives the sponsor address from
`status()`, applies the bounded expiration required by the server, and signs
once. It then submits the exact signed bytes through the upstream journal and
reconciliation lifecycle.

When no journal is supplied, Onara binds a fresh in-memory journal to that
service layer. It is suitable for a process that returns `SubmissionUnknown`
to the caller; a long-lived application that must recover across restarts
should provide a durable `JournalService` through the `journal` option to
`Onara.layer` or `onara`. (The upstream bare `Journal` reference has a
process-wide in-memory default; Onara's layer binding avoids sharing it across
service layers.) A forced validation-only server response is returned as a
dry-run result after the signed entry is written; upstream `submitVia` has no
refused state, so that entry remains pending until the application's journal
policy settles it. The same limitation applies when the server explicitly
returns an `outcome: "not_applied"` refusal after signing.

### `client.onara.getTransactionStatus(digest)`

Look up the on-chain status of a sponsored transaction by digest. The result
is a tagged union: `{ found: false }`, an `Executed` receipt, or a failed
receipt carrying `ExecutionFailed`. A `404` is treated as absence only when
the API explicitly returns `{ found: false }`; an RPC outage remains an error.

### Results and errors

Execution results are decoded `Executed` values from `@unconfirmed/sui-effect`,
including effects, gas usage, events, and base64 encoded event BCS bytes at the
HTTP boundary. The old raw Sui `TransactionResult` record is no longer the
public response type. Errors are typed Effect failures; applications can match
`OnaraError`, `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, and the
build/sign/journal errors declared by `OnaraService`.
