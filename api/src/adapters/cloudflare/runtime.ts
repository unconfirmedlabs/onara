import sponsorConfig from '../../../policies'
import {
  createOnaraRuntime,
  type OnaraEnvironment,
  type OnaraRuntime,
} from '../../core/runtime'

export type CloudflareBindings = OnaraEnvironment

export function createCloudflareRuntime(
  bindings: CloudflareBindings,
): OnaraRuntime {
  return createOnaraRuntime({
    environment: bindings,
    config: sponsorConfig,
  })
}
