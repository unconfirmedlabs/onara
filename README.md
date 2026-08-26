# Onara

Sui transaction sponsorship: a policy-based gas station server and TypeScript client SDK.

| Package | Description |
|---|---|
| [api/](./api) | Sponsorship server (Hono on Cloudflare Workers) |

The TypeScript client SDK is published as [`@unconfirmed/onara`](https://www.npmjs.com/package/@unconfirmed/onara) from the [`unconfirmedlabs/sdks`](https://github.com/unconfirmedlabs/sdks) monorepo.

## Quick start

```bash
bun install            # installs the api workspace
cd api && bun test     # run API policy tests
```
