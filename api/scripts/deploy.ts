import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { loadPolicies, type CompiledPolicies } from '../src/policy'
import { parseDynamicAuthorizationSigningKey } from '../src/dynamic-authorization'
import sponsorPoliciesConfig from '../policies'
import {
  generatePoliciesIndex,
  generateWranglerConfig,
  parseUnifiedDeploymentConfigText,
} from './deployment-config'

const API_DIR = resolve(import.meta.dir, '..')
const POLICIES_INDEX = join(API_DIR, 'policies', 'index.ts')

type ExternalDeployment = {
  policies: unknown[]
  compiledPolicies: CompiledPolicies
  wranglerConfig: string
  generatedWrangler: string | null
  dynamicAuthorizationRequirementNames: string[]
  source: 'unified' | 'legacy'
}

function parseArgs(args: string[]): {
  configDir: string | null
  dryRun: boolean
} {
  const idx = args.indexOf('--config')
  const configDir =
    idx === -1 || idx + 1 >= args.length ? null : resolve(args[idx + 1]!)
  return { configDir, dryRun: args.includes('--dry-run') }
}

function loadEnvFile(configDir: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const dir of [configDir, dirname(configDir), dirname(dirname(configDir))]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    const content = require('fs').readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq)
      let value = trimmed.slice(eq + 1)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (!(key in vars)) vars[key] = value
    }
  }
  return vars
}

async function readPoliciesFromDir(dir: string): Promise<unknown[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    throw new Error(`No policy JSON files found in ${dir}`)
  }
  const policies: unknown[] = []
  for (const file of files) {
    policies.push(JSON.parse(await readFile(join(dir, file), 'utf-8')))
  }
  console.log(
    `Loaded ${files.length} legacy policy file(s): ${files.join(', ')}`,
  )
  return policies
}

async function readLegacyPolicies(
  configDir: string,
  parsedConfigJson?: unknown,
): Promise<unknown[]> {
  if (
    parsedConfigJson !== null &&
    typeof parsedConfigJson === 'object' &&
    Array.isArray((parsedConfigJson as { policies?: unknown }).policies)
  ) {
    const policies = (parsedConfigJson as { policies: unknown[] }).policies
    console.log(`Loaded ${policies.length} legacy policy entries from config.json`)
    return policies
  }
  const policiesDir = join(configDir, 'policies')
  if (existsSync(policiesDir)) return readPoliciesFromDir(policiesDir)
  throw new Error(
    `No unified config.json or legacy policies/ directory found in ${configDir}`,
  )
}

async function loadExternalDeployment(
  configDir: string,
): Promise<ExternalDeployment> {
  const configJson = join(configDir, 'config.json')
  let parsedConfigJson: unknown
  if (existsSync(configJson)) {
    const text = await readFile(configJson, 'utf-8')
    try {
      parsedConfigJson = JSON.parse(text)
    } catch (error) {
      throw new Error(
        `Invalid ${configJson}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const isUnified =
      parsedConfigJson !== null &&
      typeof parsedConfigJson === 'object' &&
      ('version' in parsedConfigJson || 'wrangler' in parsedConfigJson)
    if (isUnified) {
      // Strict combined-config, profile resolution, Wrangler safety checks,
      // and engine policy validation all happen before any generated file is
      // written.
      const deployment = parseUnifiedDeploymentConfigText(text)
      console.log(
        `Validated unified config.json (${deployment.policies.length} policies).`,
      )
      return {
        policies: deployment.policies,
        compiledPolicies: deployment.compiledPolicies,
        wranglerConfig: '',
        generatedWrangler: generateWranglerConfig(deployment.wrangler),
        dynamicAuthorizationRequirementNames:
          deployment.dynamicAuthorizationRequirementNames,
        source: 'unified',
      }
    }
  }

  const wranglerConfig = join(configDir, 'wrangler.jsonc')
  if (!existsSync(wranglerConfig)) {
    throw new Error(`Legacy Wrangler config not found: ${wranglerConfig}`)
  }
  const policies = await readLegacyPolicies(configDir, parsedConfigJson)
  const compiledPolicies = loadPolicies(policies)
  console.warn(
    'Using legacy wrangler.jsonc + policies format. Migrate to unified config.json.',
  )
  return {
    policies,
    compiledPolicies,
    wranglerConfig,
    generatedWrangler: null,
    dynamicAuthorizationRequirementNames: compiledPolicies.require
      .filter((requirement) => requirement.enabled)
      .map((requirement) => requirement.name),
    source: 'legacy',
  }
}

function preflightDynamicAuthorizationSigningKeys(
  policies: CompiledPolicies,
  envVars: Record<string, string>,
): void {
  const keyPolicies = new Map<
    string,
    { identity: string; policies: string[] }
  >()
  for (const requirement of policies.require) {
    if (!requirement.enabled) continue
    const check = requirement.check
    const existing = keyPolicies.get(check.signingKeyEnv)
    if (existing && existing.identity !== check.signingIdentity) {
      throw new Error(
        `${check.signingKeyEnv} is configured with multiple public identities.`,
      )
    }
    const entry = existing ?? {
      identity: check.signingIdentity,
      policies: [],
    }
    const consumers = policies.allow
      .filter(
        (policy) =>
          policy.enabled && policy.requirementNames.includes(requirement.name),
      )
      .map((policy) => policy.name)
    entry.policies.push(
      ...consumers.map((policy) => `${requirement.name} -> ${policy}`),
    )
    keyPolicies.set(check.signingKeyEnv, entry)
  }

  for (const [envName, { identity, policies: policyNames }] of keyPolicies) {
    const value = envVars[envName]
    if (value === undefined) {
      // Cloudflare secret values are intentionally unreadable. Runtime still
      // derives and pins the identity before any cache lookup or HTTP request.
      console.warn(
        `Could not validate ${envName} locally (expected ${identity}; used by ${policyNames.join(', ')}). ` +
          'Ensure the Worker secret contains the matching Bech32 suiprivkey.',
      )
      continue
    }

    const keypair = parseDynamicAuthorizationSigningKey(value)
    const derivedIdentity = keypair.toSuiAddress()
    if (derivedIdentity !== identity) {
      throw new Error(
        `${envName} derives ${derivedIdentity}, but deployment config pins ${identity}.`,
      )
    }
    console.log(
      `Validated ${envName} (${keypair.getKeyScheme()}, ${derivedIdentity}) for ${policyNames.join(', ')}`,
    )
  }
}

function run(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    })
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

async function main() {
  const { configDir, dryRun } = parseArgs(process.argv.slice(2))

  if (!configDir) {
    console.log(`${dryRun ? 'Validating' : 'Deploying'} with in-tree config...`)
    const compiled = loadPolicies(sponsorPoliciesConfig)
    preflightDynamicAuthorizationSigningKeys(compiled, loadEnvFile(API_DIR))
    const args = ['wrangler', 'deploy', '--minify']
    if (dryRun) args.push('--dry-run')
    await run('npx', args, API_DIR)
    return
  }

  console.log(
    `${dryRun ? 'Validating' : 'Deploying'} external config: ${configDir}`,
  )
  const deployment = await loadExternalDeployment(configDir)
  const envVars = loadEnvFile(configDir)
  preflightDynamicAuthorizationSigningKeys(deployment.compiledPolicies, envVars)
  const authorizationNames = deployment.dynamicAuthorizationRequirementNames
  if (authorizationNames.length > 0) {
    console.log(
      `Dynamic authorization requirements: ${authorizationNames.join(', ')}`,
    )
  }

  // Everything above is read-only validation. Only now may generated files be
  // created. Both files are restored/removed on every exit path.
  const originalIndex = await readFile(POLICIES_INDEX, 'utf-8')
  const generatedIndex = generatePoliciesIndex(deployment.policies)
  let tempDir: string | null = null
  let indexWritten = false

  try {
    let wranglerConfig = deployment.wranglerConfig
    if (deployment.generatedWrangler !== null) {
      tempDir = await mkdtemp(join(tmpdir(), 'onara-deploy-'))
      wranglerConfig = join(tempDir, 'wrangler.json')
      await writeFile(wranglerConfig, deployment.generatedWrangler)
      console.log('Generated temporary Wrangler config from config.json.')
    }

    indexWritten = true
    await writeFile(POLICIES_INDEX, generatedIndex)
    console.log('Generated policies/index.ts.')

    // The positional entry point resolves against API_DIR, independent of the
    // external or temporary Wrangler config location.
    const args = [
      'wrangler',
      'deploy',
      'src/workers.ts',
      '--minify',
      '--config',
      wranglerConfig,
    ]
    if (dryRun) args.push('--dry-run')
    await run('npx', args, API_DIR, envVars)
    console.log(dryRun ? 'Deploy validation complete.' : 'Deploy complete.')
  } finally {
    try {
      if (indexWritten) {
        await writeFile(POLICIES_INDEX, originalIndex)
        console.log('Restored policies/index.ts.')
      }
    } finally {
      if (tempDir !== null) {
        await rm(tempDir, { recursive: true, force: true })
        console.log('Removed temporary Wrangler config.')
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
