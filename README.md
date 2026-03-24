# Onara

Sui transaction sponsorship: a policy-based gas station server and TypeScript client SDK.

| Package | Description |
|---|---|
| [api/](./api) | Sponsorship server (Hono on Cloudflare Workers) |
| [sdk/](./sdk) | Client SDK (`onara` on npm) |

## Quick start

```bash
bun install            # installs both workspaces
cd api && bun test     # run API policy tests
cd sdk && bun test     # run SDK tests
```
