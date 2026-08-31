import { createOnaraApp } from '../../http/app'
import { createCloudflareRuntime, type CloudflareBindings } from './runtime'

const apps = new WeakMap<object, ReturnType<typeof createOnaraApp>>()

function appFor(bindings: CloudflareBindings) {
  let app = apps.get(bindings)
  if (!app) {
    app = createOnaraApp(createCloudflareRuntime(bindings))
    apps.set(bindings, app)
  }
  return app
}

export default {
  fetch(request: Request, bindings: CloudflareBindings) {
    return appFor(bindings).fetch(request, bindings)
  },
}
