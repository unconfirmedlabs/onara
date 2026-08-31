# Onara

Sui transaction sponsorship server with a declarative policy engine. Clients submit pre-built, pre-signed transactions; the server validates them against a set of JSON policies and, if approved, co-signs with the sponsor keypair and submits on-chain.

Runs through peer **Cloudflare Workers** and **Bun** adapters.

## Quick start

```bash
bun install

# Cloudflare Worker development
bun run dev:cloudflare

# Bun server development
bun run start:bun

# Run policy tests (offline, no gas costs)
bun test

# Type-check
bun run typecheck

# Deploy to Cloudflare Workers
bun run deploy:cloudflare
```

### Environment variables

| Variable | Description |
|---|---|
| `SUI_NETWORK` | Network identifier (e.g. `testnet`, `mainnet`) |
| `SUI_GRPC_URL` | Sui gRPC endpoint URL |
| `SUI_PRIVATE_KEY` | Bech32 `suiprivkey...` for the sponsor keypair. |
| `DRY_RUN_ONLY` | Set to `true` or `1` to force `/sponsor` into validate-only mode |
| `EXECUTION_TIMEOUT_MS` | Overall preflight-through-submission deadline in ms (default: `45000`) |
| `CONFIRMATION_TIMEOUT_MS` | Max confirmation wait in ms after submission (default: `30000`) |
| `GAS_BUDGET_MAX` | Hard server-side cap on gas budget, as a decimal string in MIST (e.g. `"50000000"`). It may be omitted only when every enabled allow policy sets `gasBudgetMax`. Enforced before policy matching on `/sponsor`. |

## Adapters

### Cloudflare Workers

Deploy with the built-in `allow-all` policy and the in-tree
`adapters/cloudflare/wrangler.jsonc`:

```bash
bun install
wrangler secret put SUI_PRIVATE_KEY
bun run deploy:cloudflare
```

The default Worker has no public route and is intended to be called through a
Cloudflare Service binding. Declare the binding in each calling Worker's
`wrangler.jsonc`:

```jsonc
"services": [{ "binding": "ONARA", "service": "onara" }]
```

Then forward the request with `return env.ONARA.fetch(request)`. If a public
endpoint is required, add its route in the deployment-specific Wrangler config.

### Custom config

For production deployments, keep the host-neutral policy configuration in
`<environment>/config.json` and Cloudflare settings in the adjacent
`<environment>/wrangler.jsonc`:

```jsonc
{
  "version": 1,
  "policies": [
    {
      "type": "allow",
      "name": "my-app-policy",
      "gasBudgetMax": "1000000000",
      "commands": { "allowed": ["MoveCall"], "max": 1 },
      "calls": {
        "mode": "sequence",
        "rules": [
          {
            "id": "call",
            "targets": ["0xPACKAGE::module::function"]
          }
        ]
      }
    }
  ]
}
```

`config.json` has exactly `version` and `policies`; concrete deny and allow
branches share one flat policy array. Private keys never belong
in this file. Set the common runtime variables in the host environment, and
provide `SUI_PRIVATE_KEY` as a Worker secret on Cloudflare.

Deploy with the `--config` flag:

```bash
bun run deploy:cloudflare --config ~/my-onara-config
```

The Cloudflare deploy adapter validates the host-neutral policy configuration
before generating the Worker policy registry, and always restores the in-tree
registry after invoking Wrangler.

### Updating

Your config lives outside the repo, so pulling updates is clean:

```bash
git pull
bun install
bun run deploy:cloudflare --config ~/my-onara-config
```

No merge conflicts with policies or host configuration.

### Bun

The Bun adapter is a normal long-running HTTP server. Set the common runtime
variables and start it on any Bun-capable host:

```bash
SUI_NETWORK=testnet \
SUI_GRPC_URL=https://fullnode.testnet.sui.io:443 \
SUI_PRIVATE_KEY=suiprivkey... \
GAS_BUDGET_MAX=50000000 \
bun run start:bun
```

Set `ONARA_CONFIG_PATH=/path/to/config.json` to load an external policy
configuration; without it, the adapter uses the in-tree policy registry.

## API

### `GET /status`

Returns the network, chain identifier, sponsor address, and balances.

```json
{
  "network": "testnet",
  "chainId": "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
  "address": "0x...",
  "balances": {
    "active": "1000000000",
    "pending": "500000000"
  }
}
```

- `active` — address balance (balance accumulator), available for sponsoring transactions
- `pending` — coin balance, not yet in the balance accumulator

To fund the sponsor, send SUI to the balance accumulator using `coin::send_funds`:

```bash
sui client ptb \
  --assign sponsor @0x<SPONSOR_ADDRESS> \
  --split-coins gas "[200000000000]" \
  --assign coin \
  --move-call 0x2::coin::send_funds "<0x2::sui::SUI>" coin sponsor
```

### `POST /sponsor`

Validates, simulates, co-signs, and executes a sponsored transaction.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `waitForExecution` | `boolean` | `true` | Wait for transaction finality before responding |
| `dryRun` | `boolean` | `false` | Validate against policies only—do not simulate, sponsor-sign, or submit |
| `executionTimeoutMs` | `number` | `45000` | Preflight, simulation, sponsor-signing, and submission deadline (capped at server max) |
| `confirmationTimeoutMs` | `number` | `30000` | Confirmation wait after submission (capped at server max) |

**Request body:**

```json
{
  "sender": "0x<sender-address>",
  "txBytes": "<base64-encoded-transaction-bytes>",
  "txSignature": "<base64-encoded-sender-signature>"
}
```

**Success response (normal):** the transaction execution result from the Sui SDK.

**Success response (`dryRun=true`):**

```json
{
  "dryRun": true,
  "policy": "my-policy-name",
  "moveCallTargets": [
    "0x2::coin::zero",
    "0x2::coin::destroy_zero"
  ]
}
```

**Policy rejection (403):**

```json
{
  "error": "Transaction is not eligible for sponsorship."
}
```

Detailed policy mismatch diagnostics are written to server logs and are not
included in the HTTP response.

## Policy engine

Policies are JSON files in the `policies/` directory, registered in `policies/index.ts`. The server loads and compiles them at startup.

When a transaction arrives at `/sponsor`, the engine:

1. Rejects requests over the global/per-policy gas ceiling.
2. Verifies the sender's signature over the exact transaction bytes.
3. Verifies the embedded sender and gas owner match the request and requires an
   empty gas payment (`[]`) so gas comes only from the sponsor address balance
4. Requires an expiration no later than the next epoch
5. Rejects sponsor-scoped balance withdrawals and any command that references `GasCoin`
6. Evaluates every enabled **deny** policy first; any match rejects immediately.
7. Collects every structurally complete **allow** branch. Allow branches are
   ORed; configuration order does not lock evaluation to the first candidate.
8. Resolves every owned-object input over RPC and requires it to be sender-owned
   or immutable.
9. Selects a matching structural branch, resolving SuiNS names only when a
   surviving branch needs one.
10. For executable requests, simulates the exact sender-signed bytes, sponsor-signs
    once, and submits those same bytes. Validate-only requests stop before all
    three operations.

The algebra is `deny override; OR(allows)`. No structural match means deny by
default. User authorization and abuse controls belong at the deployment edge.

### Sponsor-only-gas invariants

The policy schema is not the only authorization boundary. Onara enforces
these invariants for every policy, independent of what a matched policy
allows:

- the transaction sender is present and matches the request sender;
- the sender is not the sponsor and supplied a valid signature for the exact bytes;
- the gas owner is present and matches the configured sponsor;
- the gas payment is exactly `[]`, so explicit gas coin objects are never used;
- expiration is bounded to the current or next epoch;
- `FundsWithdrawal` inputs may withdraw from the sender only;
- commands may not reference `GasCoin`; and
- every `ImmOrOwnedObject` command input must be sender-owned or immutable.

The last check — the owned-input RPC lookup — is defense-in-depth, not a fix
for a known chain-level hole: Sui's transaction checks already verify a
non-gas `ImmOrOwnedObject` input against the transaction *sender*, not the
gas owner, so a sponsor signature alone does not authorize spending someone
else's owned objects. Onara re-verifies this ownership itself and fails
closed — a missing object, RPC error, sponsor-owned object, parent-owned
object, shared owner in an owned-input slot, or unknown owner is rejected
before simulation and signing. Explicit gas-payment references are rejected;
the sponsor pays exclusively from its address balance.

### Policy types

Every entry has an explicit `type` and a unique `name`:

- **`deny`** rejects on `always`, `sender`, or `any-move-call`.
- **`allow`** defines one concrete structural branch.

All objects are strict: legacy fields, unknown keys, duplicate names, duplicate
list members, ambiguous call-rule target ownership, and duplicate result-flow
clauses are rejected at load time.

### Allow call modes

`calls.mode` is either:

- **`set`** — every Move call must belong to exactly one local rule; order is
  otherwise free, with optional `ordering` edges.
- **`sequence`** — local rules are consumed in declared order.

### Policy schema

```jsonc
// Deny rule
{
  "type": "deny",
  "name": "block-exploit",
  "enabled": true,
  "when": {
    "kind": "any-move-call",
    "targets": ["0xBAD_PACKAGE::*"]
  }
}

// Concrete allow branch
{
  "type": "allow",
  "name": "purchase",
  "enabled": true,
  "senders": ["0xALICE"],
  "suinsNames": ["onara.sui", "*.onara.sui"],
  "gasBudgetMax": "50000000000",
  "commands": {
    "allowed": ["MoveCall", "TransferObjects"],
    "max": 5
  },
  "calls": {
    "mode": "set",
    "rules": [
      {
        "id": "buy",
        "targets": ["0xPKG::market::buy"],
        "count": { "min": 1, "max": 3 },
        "typeArguments": {
          "0": ["0x2::sui::SUI"]
        }
      },
      {
        "id": "settle",
        "targets": ["0xPKG::market::settle"],
        "count": { "sameAs": "buy" }
      }
    ],
    "ordering": [{ "before": "buy", "after": "settle" }],
    "resultFlow": [
      {
        "from": { "rule": "buy", "result": 0 },
        "to": [{ "rule": "settle", "argument": 0 }],
        "required": true
      }
    ]
  }
}
```

### Target patterns

Targets use the `package::module::function` format. Three wildcard forms are supported:

| Pattern | Matches |
|---|---|
| `*` | Any target (universal wildcard) |
| `0xPKG::module::function` | Exact match only |
| `0xPKG::module::*` | Any function in the module |
| `0xPKG::*` | Any module and function in the package |

Package addresses are normalized to full 64-character hex (with `0x` prefix), so `0x2` and `0x0000...0002` are equivalent.
Configured and transaction type arguments are normalized the same way before
comparison.

### Call rules and counts

Every local rule has a unique `id` and nonempty `targets`. Targets may not
overlap across rules, so each Move call has one unambiguous rule identity.

Optional `count` is either:

- a range: `{ "min": 1, "max": 3 }` (either bound may be omitted); or
- equality with another local rule: `{ "sameAs": "other-rule" }`.

In set mode, an omitted count leaves multiplicity unconstrained. In sequence
mode it means exactly one call. Sequence calls are consumed greedily in rule
order; optional steps use a range such as `{ "min": 0, "max": 1 }`.

### Result flow

`calls.resultFlow` constrains one exact result slot on every occurrence of a
producer rule:

- `from.rule` identifies the local producer rule;
- `from.result` is the exact zero-based result slot;
- each `to` entry identifies an allowed local consumer rule and exact top-level
  Move-call argument index; and
- `required` defaults to `true` for every producer occurrence.

`Result(i)` means slot 0; `NestedResult(i, n)` means exactly slot `n`. The
engine recursively scans every command. Every actual use of a constrained slot
must be one of the declared Move-call top-level arguments. Native consumers
(`TransferObjects`, `SplitCoins`, `MergeCoins`, `MakeMoveVec`, or `Upgrade`) and
nested uses are rejected. Duplicate producer clauses and duplicate destinations
are configuration errors.

### Sender gates

An allow branch may use `"senders": ["0xALICE", "0xBOB"]` as a static
selector. If the sender does not match, that branch is skipped while other
structural branches remain eligible. A deny-by-sender rule instead uses
`{ "kind": "sender", "addresses": [...] }`.

User authorization and other dynamic application decisions
must be enforced by the trusted edge or proxy in front of Onara. Onara should
not be publicly reachable in a deployment that relies on those controls.

### Soft skip vs. hard rejection

These conditions cause a policy to be **silently skipped** (the engine moves to the next policy):

- `enabled: false`
- `senders` is set and does not include the transaction sender
- `suinsNames` doesn't match the sender's SuiNS name (or sender has no name)
- `gasBudgetMax` is exceeded by the transaction's gas budget

Structural failures (disallowed target, command limit/kind, call count,
ordering, sequence, result flow, or type arguments) make that allow branch
incomplete. Every other structural branch is still considered.

### SuiNS name matching

Allow policies can gate sponsorship by the sender's SuiNS name using
`suinsNames`. Resolution is lazy and request-cached: the server calls SuiNS
only when evaluation reaches a structurally complete name-gated branch. An
outage makes that branch unavailable but cannot block an independent public
or otherwise passing branch.

Name patterns follow DNS wildcard conventions (RFC 4592):

| Pattern | Matches | Does NOT match |
|---|---|---|
| `*.onara.sui` | `alice.onara.sui`, `bob.onara.sui` | `onara.sui` |
| `onara.sui` | `onara.sui` | `alice.onara.sui` |
| `*.sui` | Any `.sui` name | — |

To match both a domain and its subdomains, list both:

```json
"suinsNames": ["onara.sui", "*.onara.sui"]
```

Matching is case-insensitive (`Alice.Onara.SUI` and `alice.onara.sui` are equivalent). If the sender's address doesn't resolve to a SuiNS name, policies with `suinsNames` are skipped and the engine tries the next policy — the sender isn't rejected unless no other policy matches.

### Retry behavior

The server retries transient failures on key RPC operations (1 retry, 2 attempts total):

- **SuiNS name resolution** — only when a policy uses `suinsNames`
- **Current system state** — used to enforce bounded transaction expiration
- **Transaction simulation** — read-only, safe to retry
- **Transaction execution** — Sui deduplicates by tx digest, safe to retry; the
  sponsor signature is created once and reused across attempts

Preflight RPCs, simulation, sponsor signing, and submission share the overall
execution deadline (`EXECUTION_TIMEOUT_MS`). Confirmation is cancellation-safe
and has its own `CONFIRMATION_TIMEOUT_MS` deadline.

## Pre-v1 migration examples

The examples in this section show the retired schema and are retained only to
help identify fields that must be migrated. They are rejected by schema v1.
For executable v1 examples, use `policies/allow-all.json`,
`policies/default.json`, and the unified `config.json` example above.

### Allow all transactions

The simplest policy — sponsors any transaction from anyone:

```json
{
  "name": "allow-all",
  "targets": ["*"]
}
```

### Sponsor a SuiNS community

Only sponsor transactions from senders with a `onara.sui` subdomain:

```json
{
  "name": "onara-community",
  "suinsNames": ["onara.sui", "*.onara.sui"],
  "targets": ["*"]
}
```

With no fallback allow-all policy, senders without a matching name are rejected by default.

### Deny a specific package

Block transactions that call a known-bad package, allow everything else:

```json
[
  {
    "name": "block-exploit",
    "action": "deny",
    "targets": ["0xBAD_PACKAGE::*"]
  },
  {
    "name": "allow-all",
    "targets": ["*"]
  }
]
```

The deny rule fires first regardless of array order.

### Deny a specific sender

Block a spammer, allow everyone else:

```json
[
  {
    "name": "block-spammer",
    "action": "deny",
    "senders": { "static": ["0xSPAMMER_ADDRESS"] }
  },
  {
    "name": "allow-all",
    "targets": ["*"]
  }
]
```

### 1. Simple token mint (constraint mode)

Allow anyone to call `mint` on a specific package, at most once per transaction:

```json
{
  "name": "token-mint",
  "maxCommands": 1,
  "targets": [
    "0xYOUR_PACKAGE::token::mint"
  ],
  "callLimits": {
    "0xYOUR_PACKAGE::token::mint": { "max": 1 }
  }
}
```

### 2. Restricted sender with gas cap

Only allow two specific addresses to interact with a DeFi module, capping gas at 50 SUI:

```json
{
  "name": "defi-vip",
  "senders": {
    "static": ["0xALICE_ADDRESS", "0xBOB_ADDRESS"]
  },
  "gasBudgetMax": 50000000000,
  "targets": [
    "0xDEFI_PKG::pool::swap",
    "0xDEFI_PKG::pool::add_liquidity",
    "0xDEFI_PKG::pool::remove_liquidity"
  ]
}
```

### 3. Coin create-and-destroy with result flow

Sponsor `coin::zero` followed by `coin::destroy_zero`, ensuring the zero coin is actually consumed:

```json
{
  "name": "default-coin-zero-flow",
  "maxCommands": 2,
  "targets": [
    "0x2::coin::zero",
    "0x2::coin::destroy_zero"
  ],
  "callLimits": {
    "0x2::coin::zero": { "min": 1, "max": 1 },
    "0x2::coin::destroy_zero": { "max": 1 }
  },
  "resultFlow": [
    {
      "from": "0x2::coin::zero",
      "to": ["0x2::coin::destroy_zero"],
      "required": true
    }
  ]
}
```

### 4. NFT minting with type restriction

Allow minting but only with a specific coin type for payment:

```json
{
  "name": "nft-mint-sui-only",
  "maxCommands": 2,
  "targets": [
    "0xNFT_PKG::nft::mint",
    "0x2::coin::split"
  ],
  "typeArguments": {
    "0x2::coin::split": {
      "0": ["0x2::sui::SUI"]
    }
  }
}
```

### 5. Multi-step game action (sequence mode)

A game requires players to `begin_turn`, perform 1-3 `action` calls, then `end_turn` — in that exact order:

```json
{
  "name": "game-turn",
  "maxCommands": 5,
  "sequence": [
    { "id": "begin", "targets": ["0xGAME::game::begin_turn"], "count": 1 },
    { "id": "actions", "targets": ["0xGAME::game::action"], "min": 1, "max": 3 },
    { "id": "end", "targets": ["0xGAME::game::end_turn"], "count": 1 }
  ]
}
```

### 6. Module wildcard with ordering

Allow any function in two modules, but enforce that `setup` module calls come before `execute` module calls:

```json
{
  "name": "pipeline",
  "targets": [
    "0xPKG::setup::*",
    "0xPKG::execute::*"
  ],
  "ordering": [
    { "before": "0xPKG::setup::*", "after": "0xPKG::execute::*" }
  ]
}
```

### 7. Balanced pair with countMatch

Ensure every `borrow` is paired with a `repay`:

```json
{
  "name": "lending-balanced",
  "targets": [
    "0xLEND::pool::borrow",
    "0xLEND::pool::repay"
  ],
  "callLimits": {
    "0xLEND::pool::borrow": { "min": 1, "max": 5 },
    "0xLEND::pool::repay": { "countMatch": "0xLEND::pool::borrow" }
  }
}
```

## Adding a new policy

1. Create a JSON file in `policies/` (e.g. `policies/my-policy.json`)
2. Import it in `policies/index.ts` and add it to the array:

```typescript
import allowAll from './allow-all.json'
import myPolicy from './my-policy.json'

const sponsorPolicies = [allowAll, myPolicy]

export default sponsorPolicies
```

3. Run `bun test` to make sure existing policies still load
4. Optionally add dedicated tests in `src/policy.test.ts`

Deny policies are always evaluated first regardless of array order. Every
complete allow branch remains a candidate and branches are ORed. Configuration
order determines only which passing concrete policy name is returned when more
than one branch passes.

## Testing

```bash
bun test
```

All tests run offline using the Sui SDK's `Transaction.build()` with manually set gas data — no network calls, no gas costs. The test suite covers:

- Strict flat schema-v1 validation and duplicate/reference rejection
- Security checks (sender signature, sender/sponsor mismatch, bounded expiration)
- Sponsor-only-gas checks (empty gas payment, `GasCoin`, sender-scoped withdrawals, owned-input authorization)
- Server-level gas budget cap helpers (`src/gas-budget.test.ts`)
- Set mode (target ownership, ranges, `sameAs`, ordering)
- Wildcards (universal, module, and package level)
- Sequence mode (rule matching, count enforcement, extra command rejection)
- Exact result flow (slot and argument indexes, every producer occurrence,
  recursive rejection across every argument-bearing native command)
- Type argument validation
- Deny policies (target deny, sender deny, any-match semantics, order independence)
- SuiNS name matching (wildcard, exact, DNS RFC 4592, case insensitivity, soft-skip)
- Soft skip behavior (disabled, sender restriction, SuiNS name, gas budget fallthrough)
- OR branch selection and overlapping structural branches
- Integration test against the real `policies/default.json`

## Project structure

```
src/
  core/
    config.ts      Host-neutral policy configuration parser
    runtime.ts     Runtime configuration and shared dependencies
  http/
    app.ts         Hono HTTP app factory — /status, /sponsor
  adapters/
    bun/           Bun runtime and HTTP server entrypoint
    cloudflare/    Worker runtime and deploy adapter
  policy.ts       Policy engine — schema, compiler, validator
  policy.test.ts  Offline test suite (bun:test)
  input-authorization.ts       Sender-owned input authorization
  input-authorization.test.ts  Owned-input authorization tests
  sender-signature.ts          Exact-byte sender signature verification
  sender-signature.test.ts     Sender signature tests
  execution.ts                 Sign-once submission and confirmation flow
  execution.test.ts            Sponsor signing/submission tests
  sponsorship-analysis.ts      Immutable request facts and deduplicated RPC reads
  sponsorship-analysis.test.ts Request-scoped fact caching tests
  sponsorship-service.ts       Sponsorship pipeline shared by execution modes
  sponsorship-service.test.ts  Pipeline ordering and transport mapping tests
  gas-budget.ts                Server-level gas budget guard
  gas-budget.test.ts           Gas budget tests
policies/
  index.ts        Policy registry
  allow-all.json  Default allow-all policy (universal wildcard)
  default.json    Example coin::zero → coin::destroy_zero policy
adapters/
  cloudflare/     Wrangler configs for the Cloudflare adapter
```
