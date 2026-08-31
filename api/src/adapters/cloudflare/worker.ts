import { createOnaraApp } from '../../http/app'
import { assertOnaraRuntimeChainId } from '../../core/runtime'
import { createCloudflareRuntime, type CloudflareBindings } from './runtime'

type OnaraWorker = {
  app: ReturnType<typeof createOnaraApp>
  runtime: ReturnType<typeof createCloudflareRuntime>
}

const workers = new WeakMap<object, OnaraWorker>()

function workerFor(bindings: CloudflareBindings): OnaraWorker {
  let worker = workers.get(bindings)
  if (!worker) {
    const runtime = createCloudflareRuntime(bindings)
    worker = { runtime, app: createOnaraApp(runtime) }
    workers.set(bindings, worker)
  }
  return worker
}

export default {
  async fetch(request: Request, bindings: CloudflareBindings) {
    const worker = workerFor(bindings)
    const pathname = new URL(request.url).pathname
    if (pathname === '/livez' || pathname === '/readyz' || pathname === '/status') {
      return worker.app.fetch(request, bindings)
    }

    try {
      await assertOnaraRuntimeChainId(worker.runtime, {
        signal: AbortSignal.timeout(5_000),
      })
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'Onara chain identity check failed.',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return Response.json({ error: 'Onara is not ready.' }, { status: 503 })
    }
    return worker.app.fetch(request, bindings)
  },
}
