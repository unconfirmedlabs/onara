import { assertOnaraRuntimeChainId } from '../../core/runtime'
import { createOnaraApp } from '../../http/app'
import { createGracefulShutdown } from './graceful-shutdown'
import { createBunRuntime, type BunAdapterEnvironment } from './runtime'

const STARTUP_TIMEOUT_MS = 5_000

const port = parsePort(process.env.PORT)
const hostname = process.env.HOSTNAME || '0.0.0.0'
const runtime = createBunRuntime(process.env as BunAdapterEnvironment)
await assertOnaraRuntimeChainId(runtime, {
  signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
})
const app = createOnaraApp(runtime)

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
})

console.log(`Onara Bun adapter listening on http://${server.hostname}:${server.port}`)

const shutdown = createGracefulShutdown(server)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => shutdown(signal))
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }
  return port
}
