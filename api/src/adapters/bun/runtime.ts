import { readFileSync } from 'node:fs'
import { parseOnaraConfigText } from '../../core/config'
import {
  createOnaraRuntime,
  type OnaraEnvironment,
  type OnaraRuntime,
} from '../../core/runtime'

export type BunAdapterEnvironment = OnaraEnvironment & {
  ONARA_CONFIG_PATH?: string
}

export function createBunRuntime(
  environment: BunAdapterEnvironment,
): OnaraRuntime {
  return createOnaraRuntime({
    environment,
    policies: loadPolicies(environment),
  })
}

function loadPolicies(environment: BunAdapterEnvironment): readonly unknown[] {
  if (!environment.ONARA_CONFIG_PATH) {
    throw new Error(
      'ONARA_CONFIG_PATH must be configured for the Bun adapter. Refusing to start with an in-tree policy.',
    )
  }
  return parseOnaraConfigText(
    readFileSync(environment.ONARA_CONFIG_PATH, 'utf8'),
  ).policies
}
