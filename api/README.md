# Onara

Sui transaction sponsorship server with a declarative policy engine. Clients submit pre-built, pre-signed transactions; the server validates them against a set of JSON policies and, if approved, co-signs with the sponsor keypair and submits on-chain.

Runs on **Cloudflare Workers**.

## Quick start

```bash
bun install

# Local development
bun run dev

# Run policy tests (offline, no gas costs)
bun test

# Type-check
npx tsc --noEmit

# Deploy to Cloudflare Workers
bun run deploy
```

### Environment variables

| Variable | Description |
|---|---|
| `SUI_NETWORK` | Network identifier (e.g. `testnet`, `mainnet`) |
| `SUI_GRPC_URL` | Sui gRPC endpoint URL |
| `SUI_MNEMONIC` | BIP-39 mnemonic for the sponsor keypair |
| `DRY_RUN_ONLY` | When set, `/sponsor` always returns dry-run results |
| `EXECUTION_TIMEOUT_MS` | Max execution time in ms (default: `30000`) |

### Cloudflare bindings

| Binding | Type | Description |
|---|---|---|
| `ANALYTICS` | Analytics Engine | Optional. When bound, writes sponsorship analytics per request. |

To enable analytics, add the binding in `wrangler.jsonc`:

```jsonc
"analytics_engine_datasets": [
  { "binding": "ANALYTICS", "dataset": "sponsorship" }
]
```

## Deployment

### Quick deploy (defaults)

Deploy with the built-in `allow-all` policy and the in-tree `wrangler.jsonc`:

```bash
bun install
wrangler secret put SUI_MNEMONIC
bun run deploy
```

### Custom config

For production deployments, create a config directory outside the repo:

```
my-onara-config/
  wrangler.jsonc       # Your Cloudflare Worker config (domain, secrets, bindings)
  policies/            # Your policy JSON files (all *.json files are loaded)
    allow-all.json
    deny-exploits.json
    my-app-policy.json
```

Use `wrangler.example.jsonc` as a starting point:

```bash
cp api/wrangler.example.jsonc ~/my-onara-config/wrangler.jsonc
```

Deploy with the `--config` flag:

```bash
bun run deploy --config ~/my-onara-config
```

The deploy script reads all `*.json` files from `<config>/policies/`, generates the policy registry, deploys using your `wrangler.jsonc`, and restores the in-tree files afterward.

### Updating

Your config lives outside the repo, so pulling updates is clean:

```bash
git pull
bun install
bun run deploy --config ~/my-onara-config
```

No merge conflicts with policies or wrangler config.

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

### `GET /policies`

Returns the array of configured policy JSON configs.

### `POST /sponsor`

Validates, simulates, co-signs, and executes a sponsored transaction.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `waitForExecution` | `boolean` | `true` | Wait for transaction finality before responding |
| `dryRun` | `boolean` | `false` | Validate against policies only — do not sign or submit |
| `executionTimeoutMs` | `number` | `30000` | Execution timeout in milliseconds (capped at server max) |

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

**Error response (400):**

```json
{
  "error": "Transaction did not match any sponsor policy. ..."
}
```

## Policy engine

Policies are JSON files in the `policies/` directory, registered in `policies/index.ts`. The server loads and compiles them at startup.

When a transaction arrives at `/sponsor`, the engine:

1. Verifies the embedded sender and gas owner match the request
2. Evaluates all **deny** policies first — if any match, the transaction is rejected immediately
3. Evaluates **allow** policies in order, soft-skipping any that don't apply (disabled, sender restriction, gas budget)
4. Validates the transaction against the first applicable allow policy
5. Returns the matched policy name and called targets on success, or collects the error and tries the next policy
6. If no allow policy matches, the transaction is rejected (deny by default)

Deny policies are always evaluated before allow policies, regardless of their position in the config array. This prevents accidental misconfiguration where an allow-all rule overrides a deny rule.

### Policy actions

Each policy has an `action` field:

- **`"allow"`** (default) — permits the transaction if it matches all constraints
- **`"deny"`** — rejects the transaction if it matches

Deny policies use **any-match** target semantics: a transaction is denied if ANY of its Move calls match a denied target. Allow policies use **all-match** semantics: ALL Move calls must be in the allowed target list.

Deny policies only support `targets` and `senders`. Allow-only fields (suinsNames, callLimits, ordering, sequence, resultFlow, typeArguments, maxCommands, gasBudgetMax) are rejected at load time for deny policies.

### Allow policy modes

Each allow policy operates in exactly one of two modes:

- **Constraint mode** (`targets`) — an unordered allowlist of Move call targets with optional call limits and ordering rules
- **Sequence mode** (`sequence`) — an ordered list of steps that the transaction's commands must follow in order

### Policy schema

```jsonc
{
  // Required
  "name": "unique-policy-name",
  "action": "allow",                   // "allow" (default) or "deny"

  // Soft-skip controls (policy is silently skipped if these don't match)
  "enabled": true,                     // default: true
  "senders": ["0x<address>", ...],     // optional — restrict to specific senders
  "suinsNames": ["onara.sui", "*.onara.sui"], // optional — restrict to SuiNS name holders (allow only)
  "gasBudgetMax": 50000000,            // optional — skip if tx gas budget exceeds this (allow only)

  // Hard limits (rejection, not skip)
  "maxCommands": 5,                    // optional — max total commands in the transaction
  "allowedCommandKinds": ["MoveCall"], // default: ["MoveCall"]

  // ── Constraint mode (provide `targets`, not `sequence`) ──
  "targets": [
    "0xPKG::module::function",         // exact target
    "0xPKG::module::*",               // module wildcard — any function in module
    "0xPKG::*"                         // package wildcard — any module/function
  ],
  "callLimits": {                      // optional — per-target call count limits
    "0xPKG::mod::fn": { "min": 1, "max": 3 },
    "0xPKG::mod::other": { "countMatch": "0xPKG::mod::fn" }
  },
  "ordering": [                        // optional — relative ordering constraints
    { "before": "0xPKG::mod::init", "after": "0xPKG::mod::finalize" }
  ],

  // ── Sequence mode (provide `sequence`, not `targets`) ──
  "sequence": [
    { "id": "step1", "targets": ["0xPKG::mod::setup"], "count": 1 },
    { "id": "step2", "targets": ["0xPKG::mod::action"], "min": 1, "max": 5 },
    { "id": "step3", "targets": ["0xPKG::mod::cleanup"] }
  ],

  // ── Both modes ──
  "resultFlow": [                      // optional — constrain how return values flow
    {
      "from": "0xPKG::mod::produce",
      "to": ["0xPKG::mod::consume"],
      "required": true                 // default: true — result MUST be consumed
    }
  ],
  "typeArguments": {                   // optional — restrict type parameters
    "0xPKG::mod::fn": {
      "0": ["0x2::sui::SUI", "0xPKG::token::TOKEN"]
    }
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

### Call limits

In constraint mode, `callLimits` restrict how many times each target can appear:

- **Range:** `{ "min": 1, "max": 3 }` — at least `min`, at most `max` (either optional, but at least one required)
- **Count match:** `{ "countMatch": "0xPKG::mod::other" }` — must appear exactly as many times as the referenced target. Circular chains are rejected at load time.

### Sequence steps

In sequence mode, each step specifies:

- `id` — unique step identifier (used in error messages)
- `targets` — which Move call targets satisfy this step
- `count` — exact number of matching calls required
- `min` / `max` — range of matching calls (mutually exclusive with `count`; defaults to exactly 1 if none specified)

Commands are consumed greedily in order. If a command doesn't match the current step, the engine advances to the next step. After all steps are processed, any remaining commands cause rejection.

### Result flow

`resultFlow` rules constrain how the return values of Move calls are passed between commands:

- `from` — the producing target (which target's return value to track)
- `to` — allowed consuming targets (which targets may receive the result as an argument)
- `required` — if `true` (default), the result *must* be consumed; unconsumed results are rejected

### Soft skip vs. hard rejection

These conditions cause a policy to be **silently skipped** (the engine moves to the next policy):

- `enabled: false`
- `senders` list doesn't include the transaction sender
- `suinsNames` doesn't match the sender's SuiNS name (or sender has no name)
- `gasBudgetMax` is exceeded by the transaction's gas budget

Everything else (disallowed target, too many commands, wrong command kind, call limit violation, ordering violation, sequence mismatch, result flow violation, type argument mismatch) causes a **hard rejection** recorded as an error. If no policy matches after trying all, the collected errors are returned.

### SuiNS name matching

Allow policies can gate sponsorship by the sender's SuiNS name using `suinsNames`. When any loaded policy uses this field, the server resolves the sender's default SuiNS name via RPC before policy evaluation. When no policy uses `suinsNames`, no RPC call is made.

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
- **Transaction simulation** — read-only, safe to retry
- **Transaction execution** — Sui deduplicates by tx digest, safe to retry

Each operation is still governed by the overall execution timeout (`EXECUTION_TIMEOUT_MS`).

## Policy examples

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
    "senders": ["0xSPAMMER_ADDRESS"]
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
  "senders": [
    "0xALICE_ADDRESS",
    "0xBOB_ADDRESS"
  ],
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

Deny policies are always evaluated first regardless of array order. Within allow policies, evaluation order matters — the first matching allow policy wins. Put more specific allow policies (with `senders`, `gasBudgetMax`, or narrow targets) before broader catch-all policies.

## Analytics

When the `ANALYTICS` binding is configured, the server writes one data point per sponsored transaction to Cloudflare Workers Analytics Engine. Writes are fire-and-forget — they add no latency to the response.

### Data model

Each data point captures:

| Blobs (strings) | Doubles (numbers) |
|---|---|
| sender address | success (1.0 / 0.0) |
| epoch | request count (1.0) |
| policy name | execution duration (ms) |
| tx digest | computation cost (MIST) |
| RPC node | storage cost (MIST) |
| CF colo | storage rebate (MIST) |
| country | gas budget (MIST) |
| city | num move calls |
| continent | |
| user agent | |

The sender address is used as the sampling index for accurate per-address analytics at scale.

### Example queries

```sql
-- Total gas sponsored per sender
SELECT blob1 AS sender,
       SUM(_sample_interval * (double4 + double5 - double6)) AS total_gas
FROM sponsorship
WHERE timestamp >= NOW() - INTERVAL '30' DAY
GROUP BY blob1 ORDER BY total_gas DESC

-- Top countries by request volume
SELECT blob7 AS country, SUM(_sample_interval * double2) AS requests
FROM sponsorship
WHERE timestamp >= NOW() - INTERVAL '7' DAY
GROUP BY blob7 ORDER BY requests DESC

-- Success rate over time
SELECT intDiv(toUInt32(timestamp), 3600) * 3600 AS hour,
       SUM(_sample_interval * double1) / SUM(_sample_interval * double2) AS success_rate
FROM sponsorship
WHERE timestamp >= NOW() - INTERVAL '24' HOUR
GROUP BY hour ORDER BY hour
```

Query via the [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/). Data is retained for 3 months.

## Testing

```bash
bun test
```

All tests run offline using the Sui SDK's `Transaction.build()` with manually set gas data — no network calls, no gas costs. The test suite covers:

- Policy schema validation (invalid configs are rejected at load time)
- Security checks (sender/sponsor mismatch detection)
- Constraint mode (target matching, call limits, countMatch, ordering)
- Wildcards (universal, module, and package level)
- Sequence mode (step matching, count enforcement, extra command rejection)
- Result flow (consumption tracking, required enforcement, disallowed consumer detection)
- Type argument validation
- Deny policies (target deny, sender deny, any-match semantics, order independence)
- SuiNS name matching (wildcard, exact, DNS RFC 4592, case insensitivity, soft-skip)
- Soft skip behavior (disabled, sender restriction, SuiNS name, gas budget fallthrough)
- Integration test against the real `policies/default.json`

## Project structure

```
src/
  app.ts          Hono HTTP server — /status, /policies, /sponsor
  policy.ts       Policy engine — schema, compiler, validator
  policy.test.ts  Offline test suite (bun:test)
  workers.ts      Cloudflare Workers entrypoint
policies/
  index.ts        Policy registry
  allow-all.json  Default allow-all policy (universal wildcard)
  default.json    Example coin::zero → coin::destroy_zero policy
scripts/
  deploy.ts       Deploy script (supports external config directory)
```
