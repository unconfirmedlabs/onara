import { createOnaraApp } from '../../http/app'
import { createBunRuntime, type BunAdapterEnvironment } from './runtime'

const port = parsePort(process.env.PORT)
const hostname = process.env.HOSTNAME || '0.0.0.0'
const app = createOnaraApp(createBunRuntime(process.env as BunAdapterEnvironment))

const server = Bun.serve({
  port,
  hostname,
  fetch: app.fetch,
})

console.log(`Onara Bun adapter listening on http://${server.hostname}:${server.port}`)

function parsePort(value: string | undefined): number {
  if (value === undefined) return 3000
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.')
  }
  return port
}
