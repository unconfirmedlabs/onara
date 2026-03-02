# Onara

Sui transaction sponsorship server with a declarative policy engine. Clients submit pre-built, pre-signed transactions; the server validates them against a set of JSON policies and, if approved, co-signs with the sponsor keypair and submits on-chain.

Runs on **Bun** and **Cloudflare Workers**.

## Quick start

```bash
bun install

# Local development (reads .env)
bun run dev:bun

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
| `DRY_RUN_ONLY` | When set, `/sponsor` always returns dry-run results and `/refill` is disabled |

## API

### `GET /status`

Returns the network, chain identifier, and sponsor address.

```json
{
  "network": "testnet",
  "chainId": "4c78adac",
  "address": "0x..."
}
```

### `GET /refill/:coinId`

Merges the specified coin object back to the sponsor's gas. Useful for reclaiming scattered coins.

### `POST /sponsor`

Validates, co-signs, and executes a sponsored transaction.

**Query parameters:**

| Param | Type | Default | Description |
|---|---|---|---|
| `waitForExecution` | `boolean` | `true` | Wait for transaction finality before responding |
| `dryRun` | `boolean` | `false` | Validate against policies only — do not sign or submit |

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
2. Iterates policies in order, soft-skipping any that don't apply (disabled, sender restriction, gas budget)
3. Validates the transaction against the first applicable policy
4. Returns the matched policy name and called targets on success, or collects the error and tries the next policy
5. If no policy matches, returns all collected errors

### Policy modes

Each policy operates in exactly one of two modes:

- **Constraint mode** (`targets`) — an unordered allowlist of Move call targets with optional call limits and ordering rules
- **Sequence mode** (`sequence`) — an ordered list of steps that the transaction's commands must follow in order

### Policy schema

```jsonc
{
  // Required
  "name": "unique-policy-name",

  // Soft-skip controls (policy is silently skipped if these don't match)
  "enabled": true,                     // default: true
  "senders": ["0x<address>", ...],     // optional — restrict to specific senders
  "gasBudgetMax": 50000000,            // optional — skip if tx gas budget exceeds this

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

Targets use the `package::module::function` format. Two wildcard forms are supported:

| Pattern | Matches |
|---|---|
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
- `gasBudgetMax` is exceeded by the transaction's gas budget

Everything else (disallowed target, too many commands, wrong command kind, call limit violation, ordering violation, sequence mismatch, result flow violation, type argument mismatch) causes a **hard rejection** recorded as an error. If no policy matches after trying all, the collected errors are returned.

## Policy examples

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

### 3. Coin create-and-destroy with result flow (the default policy)

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
import defaultPolicy from './default.json'
import myPolicy from './my-policy.json'

const sponsorPolicies = [defaultPolicy, myPolicy]

export default sponsorPolicies
```

3. Run `bun test` to make sure existing policies still load
4. Optionally add dedicated tests in `src/policy.test.ts`

Policy evaluation order matters — the first matching policy wins. Put more specific policies (with `senders`, `gasBudgetMax`, or narrow targets) before broader catch-all policies.

## Testing

```bash
bun test
```

All tests run offline using the Sui SDK's `Transaction.build()` with manually set gas data — no network calls, no gas costs. The test suite covers:

- Policy schema validation (invalid configs are rejected at load time)
- Security checks (sender/sponsor mismatch detection)
- Constraint mode (target matching, call limits, countMatch, ordering)
- Wildcards (module and package level)
- Sequence mode (step matching, count enforcement, extra command rejection)
- Result flow (consumption tracking, required enforcement, disallowed consumer detection)
- Type argument validation
- Soft skip behavior (disabled, sender restriction, gas budget fallthrough)
- Integration test against the real `policies/default.json`

## Project structure

```
src/
  app.ts          Hono HTTP server — /status, /refill/:coinId, /sponsor
  policy.ts       Policy engine — schema, compiler, validator
  policy.test.ts  Offline test suite (bun:test)
  bun.ts          Bun entrypoint
  workers.ts      Cloudflare Workers entrypoint
policies/
  index.ts        Policy registry
  default.json    Default coin::zero → coin::destroy_zero policy
```
