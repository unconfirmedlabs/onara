import { SuiGrpcClient } from '@mysten/sui/grpc'
import { loadPolicies, type CompiledPolicies } from '../policy'
import { parseGasBudgetMax } from '../gas-budget'
import { parseSponsorKeypair } from '../sponsor-key'

export type OnaraEnvironment = {
  SUI_GRPC_URL?: string
  SUI_NETWORK?: string
  /** Expected immutable identifier of the chain served by SUI_GRPC_URL. */
  SUI_CHAIN_ID?: string
  SUI_PRIVATE_KEY?: string
  DRY_RUN_ONLY?: string
  EXECUTION_TIMEOUT_MS?: string
  CONFIRMATION_TIMEOUT_MS?: string
  GAS_BUDGET_MAX?: string
}

export type OnaraRuntime = {
  environment: Required<
    Pick<
      OnaraEnvironment,
      'SUI_GRPC_URL' | 'SUI_NETWORK' | 'SUI_CHAIN_ID' | 'SUI_PRIVATE_KEY'
    >
  > &
    Omit<
      OnaraEnvironment,
      'SUI_GRPC_URL' | 'SUI_NETWORK' | 'SUI_CHAIN_ID' | 'SUI_PRIVATE_KEY'
    >
  client: SuiGrpcClient
  keypair: ReturnType<typeof parseSponsorKeypair>
  sponsorAddress: string
  policies: CompiledPolicies
  gasBudgetMax: bigint | null
  forceValidateOnly: boolean
}

export function createOnaraRuntime({
  environment,
  policies,
}: {
  environment: OnaraEnvironment
  policies: readonly unknown[]
}): OnaraRuntime {
  const SUI_GRPC_URL = requiredEnvironmentValue(environment, 'SUI_GRPC_URL')
  const SUI_NETWORK = requiredEnvironmentValue(environment, 'SUI_NETWORK')
  const SUI_CHAIN_ID = requiredEnvironmentValue(environment, 'SUI_CHAIN_ID')
  const SUI_PRIVATE_KEY = requiredEnvironmentValue(environment, 'SUI_PRIVATE_KEY')
  const compiledPolicies = loadPolicies([...policies])
  const gasBudgetMax = parseGasBudgetMax(environment.GAS_BUDGET_MAX)

  if (
    gasBudgetMax === null &&
    compiledPolicies.allow.some(
      (policy) => policy.enabled && policy.gasBudgetMax === null,
    )
  ) {
    throw new Error(
      'GAS_BUDGET_MAX is required unless every enabled allow policy sets gasBudgetMax.',
    )
  }

  const keypair = parseSponsorKeypair(SUI_PRIVATE_KEY)
  return {
    environment: {
      ...environment,
      SUI_GRPC_URL,
      SUI_NETWORK,
      SUI_CHAIN_ID,
      SUI_PRIVATE_KEY,
    },
    client: new SuiGrpcClient({ network: SUI_NETWORK, baseUrl: SUI_GRPC_URL }),
    keypair,
    sponsorAddress: keypair.toSuiAddress(),
    policies: compiledPolicies,
    gasBudgetMax,
    forceValidateOnly:
      environment.DRY_RUN_ONLY === 'true' || environment.DRY_RUN_ONLY === '1',
  }
}

/**
 * Proves that the configured RPC endpoint belongs to the intended chain.
 * SUI_NETWORK only configures SDK behavior; it is not an RPC endpoint check.
 */
export async function assertOnaraRuntimeChainId(
  runtime: OnaraRuntime,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  const { chainIdentifier } = await runtime.client.core.getChainIdentifier({
    signal,
  })
  if (chainIdentifier !== runtime.environment.SUI_CHAIN_ID) {
    throw new Error(
      `SUI_CHAIN_ID mismatch: expected ${runtime.environment.SUI_CHAIN_ID}, RPC endpoint reports ${chainIdentifier}.`,
    )
  }
  return chainIdentifier
}

/**
 * Verifies both chain identity and live RPC access. The system-state request is
 * intentionally uncached, so readiness remains meaningful after startup.
 */
export async function assertOnaraRuntimeReady(
  runtime: OnaraRuntime,
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  const [chainId] = await Promise.all([
    assertOnaraRuntimeChainId(runtime, { signal }),
    runtime.client.core.getCurrentSystemState({ signal }),
  ])
  return chainId
}

function requiredEnvironmentValue(
  environment: OnaraEnvironment,
  name: keyof OnaraEnvironment,
): string {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be configured.`)
  }
  return value
}
