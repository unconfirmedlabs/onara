import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Layer, ManagedRuntime } from 'effect'
import { Sui, SuiCore } from '@unconfirmed/sui-effect'
import { Journal, Signer, type Signer as EffectSigner } from '@unconfirmed/sui-effect/tx'
import type { CompiledPolicies } from '../policy'
import type { OnaraConfig } from './config'
import { loadPolicyConfig } from './policy-digest'
import { version as engineVersion } from '../../package.json'
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
  sponsorSigner: EffectSigner
  /** One reusable Effect runtime for all requests handled by this isolate. */
  effectRuntime: ManagedRuntime.ManagedRuntime<Sui, never>
  sponsorAddress: string
  policies: CompiledPolicies
  config: OnaraConfig
  policyDigest: string
  policyVersion: OnaraConfig['version']
  engineVersion: string
  gasBudgetMax: bigint | null
  forceValidateOnly: boolean
}

export function createOnaraRuntime({
  environment,
  config,
}: {
  environment: OnaraEnvironment
  config: unknown
}): OnaraRuntime {
  const SUI_GRPC_URL = requiredEnvironmentValue(environment, 'SUI_GRPC_URL')
  const SUI_NETWORK = requiredEnvironmentValue(environment, 'SUI_NETWORK')
  const SUI_CHAIN_ID = requiredEnvironmentValue(environment, 'SUI_CHAIN_ID')
  const SUI_PRIVATE_KEY = requiredEnvironmentValue(environment, 'SUI_PRIVATE_KEY')
  const policyConfig = loadPolicyConfig(config)
  const compiledPolicies = policyConfig.policies
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
  const sponsorSigner = Signer.fromSdkSigner(keypair)
  const client = new SuiGrpcClient({ network: SUI_NETWORK, baseUrl: SUI_GRPC_URL })
  const effectRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      Sui.layerNoDepsPinned(SUI_CHAIN_ID).pipe(
        Layer.provide(SuiCore.layerFromClient(
          client,
        )),
      ),
      Journal.layerMemory,
    ),
  )
  return {
    environment: {
      ...environment,
      SUI_GRPC_URL,
      SUI_NETWORK,
      SUI_CHAIN_ID,
      SUI_PRIVATE_KEY,
    },
    client,
    keypair,
    sponsorSigner,
    effectRuntime,
    sponsorAddress: keypair.toSuiAddress(),
    ...policyConfig,
    engineVersion,
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
