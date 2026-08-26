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
bun run typecheck

# Deploy to Cloudflare Workers
bun run deploy
```

### Environment variables

| Variable | Description |
|---|---|
| `SUI_NETWORK` | Network identifier (e.g. `testnet`, `mainnet`) |
| `SUI_GRPC_URL` | Sui gRPC endpoint URL |
| `SUI_MNEMONIC` | BIP-39 mnemonic for the sponsor keypair |
| Requirement-selected signing keys | Each `require.check.signingKeyEnv` names a Worker secret containing a Bech32 `suiprivkey...`. Use a dedicated request-signing key rather than the sponsor mnemonic/key. |
| `DRY_RUN_ONLY` | When set, `/sponsor` always returns dry-run results |
| `EXECUTION_TIMEOUT_MS` | Max execution time in ms (default: `30000`) |
| `GAS_BUDGET_MAX` | Optional. Hard server-side cap on gas budget, as a decimal string in MIST (e.g. `"50000000000"`). Enforced before policy matching on both `/sponsor` and `/sponsor/ws` — independent of any per-policy `gasBudgetMax`, which only soft-skips a policy. |

### Cloudflare bindings

| Binding | Type | Description |
|---|---|---|
| `ANALYTICS` | Analytics Engine | Optional. When bound, writes sponsorship analytics per request. |
| `SENDER_RATE_LIMIT` | Rate Limiting | Optional. When bound, caps requests per sender address. Absent = no per-sender limit. |
| `IP_RATE_LIMIT` | Rate Limiting | Optional. When bound, caps requests per `cf-connecting-ip`. Absent = no per-IP limit. |
| `DYNAMIC_SENDERS_CACHE` | KV Namespace | Optional. Caches allow decisions from `sender.dynamic` requirement checks that set `cacheTtlSeconds > 0`. Absent = requirement checks are never cached. |

To enable analytics, add the binding in `wrangler.jsonc`:

```jsonc
"analytics_engine_datasets": [
  { "binding": "ANALYTICS", "dataset": "sponsorship" }
]
```

To enable rate limiting, add the bindings under `unsafe.bindings` in `wrangler.jsonc`
(the `period` must be `10` or `60` seconds):

```jsonc
"unsafe": {
  "bindings": [
    {
      "name": "SENDER_RATE_LIMIT",
      "type": "ratelimit",
      "namespace_id": "1001",
      "simple": { "limit": 10, "period": 60 }
    },
    {
      "name": "IP_RATE_LIMIT",
      "type": "ratelimit",
      "namespace_id": "1002",
      "simple": { "limit": 30, "period": 60 }
    }
  ]
}
```

Both bindings are checked, in order (sender then IP), before policy matching,
simulation, and signing. Either binding may be omitted independently — an
unbound limiter simply isn't enforced. A request that exceeds either limit is
rejected with `429` over HTTP, or a WebSocket close code `1008` with a
rate-limit error message.

## Deployment

### Quick deploy (defaults)

Deploy with the built-in `allow-all` policy and the in-tree `wrangler.jsonc`:

```bash
bun install
wrangler secret put SUI_MNEMONIC
bun run deploy
```

### Custom config

For production deployments, use one authoritative `<environment>/config.json`
outside the repo. It contains only public Wrangler settings and the ordered
policy array:

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
      "name": "example-sender",
      "check": {
        "kind": "sender.dynamic",
        "url": "https://api.example.com/v1/onara/authorize",
        "audience": "example-onara-authorization",
        "signingKeyEnv": "EXAMPLE_ONARA_SIGNING_KEY",
        "signingIdentity": "0x<canonical-public-address>",
        "timeoutMs": 1500,
        "cacheTtlSeconds": 0
      }
    },
    {
      "type": "allow",
      "name": "my-app-policy",
      "requires": ["example-sender"],
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

`config.json` has exactly `version`, `wrangler`, and `policies`; named
requirements and concrete allow branches share one flat policy array. Private
keys never belong in this file. `signingKeyEnv` is only the name of a separately
provisioned Worker secret, while `signingIdentity` is its safe-to-publish
expected Sui address.

Deploy with the `--config` flag:

```bash
bun run deploy --config ~/my-onara-config
```

The deploy script strictly validates the unified envelope, public Wrangler
settings, and complete policy set before writing generated files or invoking
Wrangler. It generates temporary Wrangler/policy files and restores/removes
them on every exit. The older `<config>/wrangler.jsonc` plus
`<config>/policies/*.json` layout remains supported for migration, but new
deployments should use unified `config.json`.
For each dynamic sender signing key found in a local `.env`, deploy preflight
also parses the Bech32 key, derives its address, and requires it to equal the
policy's `signingIdentity`; logs contain only the scheme/address. Cloudflare
does not expose existing remote secret values, so a missing local value warns.
Runtime repeats the identity check before any cache read or authorizer request.

For a staged rollout, disable both the requirement and any allow branches that
will reference it. `signingIdentity` remains a canonical public Sui address
even while disabled; placeholder private-key or identity values are rejected.

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
  "error": "Transaction did not match any allow policy. ..."
}
```

**Error response (429, rate limited):**

```json
{
  "error": "Rate limit exceeded for sender 0x...."
}
```

## Policy engine

Policies are JSON files in the `policies/` directory, registered in `policies/index.ts`. The server loads and compiles them at startup.

When a transaction arrives at `/sponsor` (or `/sponsor/ws`), the engine:

1. Rejects requests over the `GAS_BUDGET_MAX` server cap (if configured) and requests that exceed the `SENDER_RATE_LIMIT` / `IP_RATE_LIMIT` bindings (if bound) — before any policy matching, simulation, or signing
2. Verifies the embedded sender and gas owner match the request
3. Rejects sponsor-scoped balance withdrawals and any command that references `GasCoin`
4. Evaluates every enabled **deny** policy first; any match rejects immediately.
5. Collects every structurally complete **allow** branch. Allow branches are
   ORed; configuration order does not lock evaluation to the first candidate.
6. Resolves every owned-object input over RPC and requires it to be sender-owned
   or immutable.
7. Evaluates each branch's named requirements with AND semantics. A passing
   branch authorizes the transaction. If none passes, an unavailable branch
   produces `503`; otherwise all branches are denied and produce `403`.
8. Returns the winning concrete allow-policy name and called targets.

The algebra is `deny override; OR(allows); AND(requirements)`. An allow with
`"requires": []` is an explicit public branch. No structural match means deny
by default.

### Sponsor-only-gas invariants

The policy schema is not the only authorization boundary. Onara enforces
these invariants for every policy, independent of what a matched policy
allows:

- the transaction sender is present and matches the request sender;
- the gas owner is present and matches the configured sponsor;
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
before simulation and signing. Explicit gas-payment references remain
separate from command inputs and may be sponsor-owned.

### Policy types

Every entry has an explicit `type` and a unique `name`:

- **`require`** defines a reusable external check. Schema v1 supports
  `sender.dynamic`.
- **`deny`** rejects on `always`, `sender`, or `any-move-call`.
- **`allow`** defines one concrete structural branch and its mandatory
  `requires` array.

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
// Named requirement
{
  "type": "require",
  "name": "trusted-sender",
  "enabled": true,
  "check": {
    "kind": "sender.dynamic",
    "url": "https://issuer.example.com/onara/authorize",
    "audience": "issuer-onara-authorization",
    "signingKeyEnv": "ISSUER_ONARA_SIGNING_KEY",
    "signingIdentity": "0x<64-lowercase-hex>",
    "timeoutMs": 1500,
    "cacheTtlSeconds": 0
  }
}

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
  "requires": ["trusted-sender"],
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

### Sender gates and dynamic requirements

An allow branch may use `"senders": ["0xALICE", "0xBOB"]` as a synchronous
static selector. If the sender does not match, that branch is skipped while
other structural branches remain eligible. A deny-by-sender rule instead uses
`{ "kind": "sender", "addresses": [...] }`.

External authorization is a named `require` policy with
`check.kind: "sender.dynamic"`. Every enabled allow branch lists its named
requirements in the mandatory `requires` array. Requirements are ANDed within
one branch; structurally complete allow branches are ORed. The server signs and
caches the exact `(requirement name, concrete allow policy name)` tuple, so an
authorization for one branch cannot be replayed as another:

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | — | Endpoint to call. Must be `https://`, except `http://localhost` / `http://127.0.0.1` for local development. |
| `audience` | `string` | — | Required endpoint/trust-domain identifier included in the signed payload. The receiver must independently pin the same value. Use different audiences for endpoints that must not accept one another's requests. Visible ASCII only. |
| `signingKeyEnv` | `string` | — | Required name of a Worker secret containing a Bech32 `suiprivkey...`. Each policy/endpoint can select a different key; raw private keys are rejected in policy JSON. |
| `signingIdentity` | `string` | — | Required canonical Sui address expected from `signingKeyEnv`. The derived runtime identity must match before cache lookup or HTTP. |
| `timeoutMs` | `number` | `1500` | Request timeout in milliseconds. |
| `cacheTtlSeconds` | `number` | `0` | If `> 0`, cache an **allow** decision for the complete trust tuple (including requirement and concrete allow policy) for this many seconds. Must be `0` or `>= 60`. |

Onara sends a `GET` request authenticated with a Sui personal-message
signature. The exact headers are:

```
GET <url>
X-Onara-Audience: <configured audience>
X-Onara-Sender: <normalized sender address>
X-Onara-Requirement: <named requirement>
X-Onara-Policy: <concrete allow policy>
X-Onara-Network: <SUI_NETWORK>
X-Onara-Timestamp: <unix seconds>
X-Onara-Request-Id: <lowercase UUID v4>
X-Onara-Identity: <normalized Sui address of the signing key>
X-Onara-Signature: <serialized Sui personal-message signature>
User-Agent: onara
```

The signed personal-message bytes are the UTF-8 encoding of the following
canonical payload, in this exact field order, with no trailing newline:

```text
onara.dynamic-senders.v1
audience:<audience>
sender:<normalized-0x-plus-64-lowercase-hex>
requirement:<named-requirement>
policy:<matched-policy-name>
network:<SUI_NETWORK>
timestamp:<unix-seconds>
request-id:<lowercase-uuid-v4>
method:GET
```

Audience, requirement, policy, and network values must contain only visible ASCII, may
contain interior spaces, and may not have leading/trailing whitespace. Policy
config is validated at load/deploy time; a malformed runtime network, missing
key, malformed key, key/address mismatch, or signing error makes the authorizer
unavailable and can never produce an allow.

The sender is always the address parsed and verified from the transaction
bytes, normalized to lowercase `0x` + 64 hex digits — **not** the raw
request field — so your app-side store must normalize addresses the same
way before comparing.

The receiver must independently configure its expected audience, network,
allowed requirement/policy tuples, and trusted Onara signer addresses. It must
verify the personal-message signature and require:

1. the recovered signer address equals `X-Onara-Identity`;
2. that address is in the receiver's configured trusted-signer set; and
3. audience, network, requirement, concrete policy, method, and timestamp meet
   receiver policy.

Never trust an identity merely because it arrived in the request: an attacker
can sign with their own key and supply their own valid identity. The timestamp
window limits replay lifetime. `X-Onara-Request-Id` is signed and unique per
outbound request, but is only correlation data unless the receiver stores
consumed IDs for at least the accepted timestamp window.

**Deterministic interoperability vector.** This fixture is public test
material and must never be used in production:

```text
scheme: ED25519
private key: suiprivkey1qqqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszasa5uj
identity: 0x29dfbf688abce7ab43bb8e70cae158ae961196e721440f515482f8ba1684390f
signature: ANL2jUvYl/SrberxO5hOgmIAPfYw9e0K9Y/jI8d1fe/cTvTrH44saeRNJIlmz/O6ForPLZGeZWKobzXR/WDznwaKiOPddAnxlf1S2y08ul1yymcJvx2UEhvzdIgBtA9vXA==
```

The signature is over this exact personal-message payload (again, no final
newline):

```text
onara.dynamic-senders.v1
audience:miso-onara-authorization
sender:0x0000000000000000000000000000000000000000000000000000000000000001
requirement:miso-enoki-sender
policy:miso-sponsored-transactions
network:testnet
timestamp:1700000000
request-id:123e4567-e89b-42d3-a456-426614174000
method:GET
```

**Response contract:**

| Status | Meaning |
|---|---|
| `204` | Allow. Cached if `cacheTtlSeconds > 0`. |
| `403` | Requirement is false. Never cached. Other structurally complete allow branches are still evaluated. |
| Anything else, timeout, or network error | Requirement is unavailable. Never cached. If no branch passes and any branch remains unavailable, the client receives `503`. |

A minimal Hono authorizer endpoint, using Onara's exported reference verifier
and a KV lookup:

```ts
app.get('/onara/authorize', async (c) => {
  const request = {
    audience: c.req.header('X-Onara-Audience') ?? '',
    sender: c.req.header('X-Onara-Sender') ?? '',
    requirementName: c.req.header('X-Onara-Requirement') ?? '',
    policyName: c.req.header('X-Onara-Policy') ?? '',
    network: c.req.header('X-Onara-Network') ?? '',
    timestamp: Number(c.req.header('X-Onara-Timestamp')),
    requestId: c.req.header('X-Onara-Request-Id') ?? '',
    identity: c.req.header('X-Onara-Identity') ?? '',
    signature: c.req.header('X-Onara-Signature') ?? '',
  }

  // These trust values come from receiver config, not request headers.
  const ok = await verifyDynamicSenderAuthorization({
    ...request,
    requestMethod: c.req.method,
    expectedAudience: c.env.ONARA_DYNAMIC_AUDIENCE,
    expectedNetwork: c.env.SUI_NETWORK,
    allowedRequirementPolicies: {
      [c.env.ONARA_REQUIREMENT]: c.env.ONARA_ALLOWED_POLICIES.split(','),
    },
    trustedIdentities: c.env.ONARA_TRUSTED_SIGNERS.split(','),
  })
  if (!ok) return c.body(null, 403)

  const allowed = await c.env.WHITELIST_KV.get(
    `${request.requirementName}:${request.policyName}:${request.sender}`,
  )
  return c.body(null, allowed ? 204 : 403)
})
```

Set each caller key with `wrangler secret put <signingKeyEnv>`. Use a dedicated
request-signing identity rather than reusing the sponsor gas key. To rotate,
configure receivers to trust old and new signer addresses, update Onara's
secret, then remove the old receiver trust after the maximum timestamp window
and any allow-cache TTL have elapsed. Multiple requirements in the same deliberate
trust domain may explicitly reuse a key, but separate operators/endpoints
should use separate key envs and audiences.

Bind a KV namespace as `DYNAMIC_SENDERS_CACHE` if any requirement sets
`cacheTtlSeconds > 0` — see `wrangler.example.jsonc`.

**Migration from HMAC.** The old `secretEnv` field and implicit
`DYNAMIC_SENDERS_SECRET` default are rejected. Replace them with explicit
`audience`, `signingKeyEnv`, and `signingIdentity` fields, provision a Bech32
Sui private key on Onara, and configure the receiver with the corresponding
trusted Sui address.
There is no automatic fallback to HMAC because an ambiguous or partially
migrated auth mode must fail closed.

### Soft skip vs. hard rejection

These conditions cause a policy to be **silently skipped** (the engine moves to the next policy):

- `enabled: false`
- `senders` is set and does not include the transaction sender
- `suinsNames` doesn't match the sender's SuiNS name (or sender has no name)
- `gasBudgetMax` is exceeded by the transaction's gas budget

Structural failures (disallowed target, command limit/kind, call count,
ordering, sequence, result flow, or type arguments) make that allow branch
incomplete. Every other structural branch is still considered. Dynamic
requirements run only for complete branches.

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
complete allow branch remains a candidate; named requirements are ANDed within
each branch and branches are ORed. Configuration order determines only which
passing concrete policy name is returned when more than one branch passes.

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

- Strict flat schema-v1 validation and duplicate/reference rejection
- Security checks (sender/sponsor mismatch detection)
- Sponsor-only-gas checks (`GasCoin`, sender-scoped withdrawals, owned-input authorization)
- Server-level gas budget cap and per-sender/per-IP rate limit helpers (`src/request-guards.test.ts`)
- Set mode (target ownership, ranges, `sameAs`, ordering)
- Wildcards (universal, module, and package level)
- Sequence mode (rule matching, count enforcement, extra command rejection)
- Exact result flow (slot and argument indexes, every producer occurrence,
  recursive rejection across every argument-bearing native command)
- Type argument validation
- Deny policies (target deny, sender deny, any-match semantics, order independence)
- SuiNS name matching (wildcard, exact, DNS RFC 4592, case insensitivity, soft-skip)
- Soft skip behavior (disabled, sender restriction, SuiNS name, gas budget fallthrough)
- OR/AND/tri-state requirement algebra and overlapping structural branches
- Dynamic sender requirements — exact requirement/policy tuple signing,
  tamper/cross-domain/replay-window cases, trust pinning, key rotation, response
  mapping, caching, and redirects (`src/dynamic-senders.test.ts`)
- Integration test against the real `policies/default.json`

## Project structure

```
src/
  app.ts          Hono HTTP server — /status, /policies, /sponsor, /sponsor/ws
  policy.ts       Policy engine — schema, compiler, validator
  policy.test.ts  Offline test suite (bun:test)
  input-authorization.ts       Sender-owned input authorization
  input-authorization.test.ts  Owned-input authorization tests
  request-guards.ts            Gas budget cap + rate limit helpers (HTTP + WS)
  request-guards.test.ts       Request guard tests
  dynamic-senders.ts           Dynamic sender whitelist HTTP check (Sui request signing, verification reference, caching)
  dynamic-senders.test.ts      Dynamic sender whitelist tests
  workers.ts      Cloudflare Workers entrypoint
policies/
  index.ts        Policy registry
  allow-all.json  Default allow-all policy (universal wildcard)
  default.json    Example coin::zero → coin::destroy_zero policy
scripts/
  deploy.ts       Deploy script (supports external config directory)
```
