# @unconfirmed/onara

TypeScript client SDK for [Onara](../api) — a Sui transaction sponsorship server.

## Install

```bash
bun add @unconfirmed/onara @mysten/sui
```

## Usage

```typescript
import { OnaraClient } from '@unconfirmed/onara'

const onara = new OnaraClient('https://my-onara.example.com')

// Check sponsor status
const { address, balances } = await onara.status()

// View configured policies
const policies = await onara.policies()

// Sponsor a transaction (high-level convenience)
const result = await onara.sponsorTransaction({
  transaction: tx,
  signer: keypair,
  client: suiClient,
})

// Sponsor pre-built bytes (low-level)
const result = await onara.sponsor({
  sender: '0x...',
  txBytes: '...',
  txSignature: '...',
  dryRun: true,
})
```

## API

### `new OnaraClient(url)`

Create a client with a base URL string.

### `new OnaraClient({ url, fetch? })`

Create a client with options. The optional `fetch` parameter allows injecting a custom fetch implementation (useful for testing).

### `client.status()`

Returns the server's network, chain identifier, sponsor address, and balances.

### `client.policies()`

Returns the array of configured policy configs.

### `client.sponsor(options)`

Submit pre-built transaction bytes for sponsorship.

- `sender` — Sui address of the transaction sender
- `txBytes` — base64-encoded transaction bytes
- `txSignature` — base64-encoded sender signature
- `dryRun?` — validate against policies without submitting
- `waitForExecution?` — wait for transaction finality

### `client.sponsorTransaction(options)`

High-level convenience that builds, signs, and sponsors a transaction.

- `transaction` — a Sui `Transaction` instance
- `signer` — a Sui `Signer` (e.g. `Ed25519Keypair`)
- `client` — a Sui client for building the transaction
- `dryRun?` — validate against policies without submitting
- `waitForExecution?` — wait for transaction finality
