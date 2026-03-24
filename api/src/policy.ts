import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress, isValidSuiAddress } from '@mysten/sui/utils'

// ─── Utilities ───────────────────────────────────────────────────────────────

const getMoveCallTarget = ({
  packageId,
  module,
  functionName,
}: {
  packageId: string
  module: string
  functionName: string
}) => `${normalizeSuiAddress(packageId)}::${module}::${functionName}`

// ─── Target Pattern System ───────────────────────────────────────────────────

type UniversalPattern = { kind: 'universal' }
type ExactPattern = { kind: 'exact'; target: string }
type ModulePattern = { kind: 'module'; prefix: string }
type PackagePattern = { kind: 'package'; prefix: string }
type TargetPattern = UniversalPattern | ExactPattern | ModulePattern | PackagePattern

const parseTargetPattern = (raw: string): TargetPattern => {
  if (raw.trim() === '*') return { kind: 'universal' }

  const parts = raw.trim().split('::')

  if (parts.length === 2 && parts[1] === '*') {
    const addr = parts[0]!
    if (!isValidSuiAddress(addr)) {
      throw new Error(`Invalid package address in pattern: ${raw}`)
    }
    return { kind: 'package', prefix: normalizeSuiAddress(addr) }
  }

  if (parts.length === 3 && parts[2] === '*') {
    const addr = parts[0]!
    if (!isValidSuiAddress(addr)) {
      throw new Error(`Invalid package address in pattern: ${raw}`)
    }
    return { kind: 'module', prefix: `${normalizeSuiAddress(addr)}::${parts[1]}` }
  }

  if (parts.length === 3) {
    const addr = parts[0]!
    if (!isValidSuiAddress(addr)) {
      throw new Error(`Invalid package address in target: ${raw}`)
    }
    return {
      kind: 'exact',
      target: `${normalizeSuiAddress(addr)}::${parts[1]}::${parts[2]}`,
    }
  }

  throw new Error(`Invalid target pattern format: ${raw}`)
}

type TargetMatcher = {
  matchAll: boolean
  exact: Set<string>
  modules: Set<string>
  packages: Set<string>
}

const buildTargetMatcher = (patterns: TargetPattern[]): TargetMatcher => {
  let matchAll = false
  const exact = new Set<string>()
  const modules = new Set<string>()
  const packages = new Set<string>()

  for (const p of patterns) {
    switch (p.kind) {
      case 'universal':
        matchAll = true
        break
      case 'exact':
        exact.add(p.target)
        break
      case 'module':
        modules.add(p.prefix)
        break
      case 'package':
        packages.add(p.prefix)
        break
    }
  }

  return { matchAll, exact, modules, packages }
}

const matchTarget = (target: string, matcher: TargetMatcher): boolean => {
  if (matcher.matchAll) return true
  if (matcher.exact.size > 0 && matcher.exact.has(target)) return true

  if (matcher.modules.size > 0) {
    const lastSep = target.lastIndexOf('::')
    if (lastSep !== -1 && matcher.modules.has(target.slice(0, lastSep)))
      return true
  }

  if (matcher.packages.size > 0) {
    const firstSep = target.indexOf('::')
    if (firstSep !== -1 && matcher.packages.has(target.slice(0, firstSep)))
      return true
  }

  return false
}

// ─── SuiNS Name Pattern System ───────────────────────────────────────────────

type SuinsNamePattern =
  | { kind: 'exact'; name: string }
  | { kind: 'wildcard'; suffix: string }

const parseSuinsNamePattern = (raw: string): SuinsNamePattern => {
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.startsWith('*.')) {
    return { kind: 'wildcard', suffix: trimmed.slice(1) } // e.g., ".sona.sui"
  }
  return { kind: 'exact', name: trimmed }
}

const matchSuinsName = (
  name: string | null,
  patterns: SuinsNamePattern[],
): boolean => {
  if (name === null) return false
  const normalized = name.toLowerCase()
  return patterns.some((p) => {
    if (p.kind === 'exact') return normalized === p.name
    return normalized.endsWith(p.suffix) && normalized.length > p.suffix.length
  })
}

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const callLimitRangeSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    ({ min, max }) => min !== undefined || max !== undefined,
    'At least one of min or max is required.',
  )
  .refine(
    ({ min, max }) => min === undefined || max === undefined || min <= max,
    'min cannot be greater than max.',
  )

const callLimitCountMatchSchema = z
  .object({
    countMatch: z.string().trim().min(1),
  })
  .strict()

const callLimitSchema = z.union([
  callLimitRangeSchema,
  callLimitCountMatchSchema,
])

const sequenceStepSchema = z
  .object({
    id: z.string().trim().min(1),
    targets: z.array(z.string().trim().min(1)).min(1),
    count: z.number().int().positive().optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().optional(),
  })
  .refine(
    ({ count, min, max }) => {
      if (count !== undefined && (min !== undefined || max !== undefined))
        return false
      return true
    },
    'count and min/max are mutually exclusive.',
  )
  .refine(
    ({ min, max }) => min === undefined || max === undefined || min <= max,
    'min cannot be greater than max.',
  )

const orderingRuleSchema = z.object({
  before: z.string().trim().min(1),
  after: z.string().trim().min(1),
})

const resultFlowRuleSchema = z.object({
  from: z.string().trim().min(1),
  to: z.array(z.string().trim().min(1)).min(1),
  required: z.boolean().default(true),
})

const policySchema = z
  .object({
    name: z.string().trim().min(1),
    action: z.enum(['allow', 'deny']).default('allow'),
    enabled: z.boolean().default(true),
    senders: z.array(z.string().trim().min(1)).optional(),
    suinsNames: z.array(z.string().trim().min(1)).optional(),
    gasBudgetMax: z.number().int().positive().optional(),
    allowedCommandKinds: z
      .array(z.string().trim().min(1))
      .default(['MoveCall']),
    maxCommands: z.number().int().positive().optional(),

    // Constraint mode
    targets: z.array(z.string().trim().min(1)).min(1).optional(),
    callLimits: z.record(z.string(), callLimitSchema).optional(),
    ordering: z.array(orderingRuleSchema).optional(),

    // Sequence mode
    sequence: z.array(sequenceStepSchema).min(1).optional(),

    // Both modes
    resultFlow: z.array(resultFlowRuleSchema).optional(),
    typeArguments: z
      .record(
        z.string(),
        z.record(z.string(), z.array(z.string().trim().min(1)).min(1)),
      )
      .optional(),
  })
  .refine(
    (data) => {
      // Deny policies don't require targets or sequence
      if (data.action === 'deny') return true
      // Allow policies require exactly one of targets or sequence
      const hasTargets = data.targets !== undefined
      const hasSequence = data.sequence !== undefined
      if (!hasTargets && !hasSequence) return false
      if (hasTargets && hasSequence) return false
      return true
    },
    'Allow policies require exactly one of targets or sequence.',
  )
  .refine(
    (data) => {
      if (data.sequence !== undefined) {
        if (data.callLimits !== undefined || data.ordering !== undefined)
          return false
      }
      return true
    },
    'callLimits and ordering are only valid with targets mode.',
  )
  .refine(
    (data) => {
      if (data.action !== 'deny') return true
      // Deny policies only support targets and senders
      if (data.suinsNames !== undefined) return false
      if (data.sequence !== undefined) return false
      if (data.callLimits !== undefined) return false
      if (data.ordering !== undefined) return false
      if (data.resultFlow !== undefined) return false
      if (data.typeArguments !== undefined) return false
      if (data.maxCommands !== undefined) return false
      if (data.gasBudgetMax !== undefined) return false
      return true
    },
    'Deny policies only support targets and senders.',
  )

// ─── Compiled Types ──────────────────────────────────────────────────────────

type CompiledCallLimit =
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'countMatch'; target: string }

type CompiledResultFlowRule = {
  fromMatcher: TargetMatcher
  toMatcher: TargetMatcher
  required: boolean
}

type CompiledOrderingRule = {
  beforeMatcher: TargetMatcher
  afterMatcher: TargetMatcher
}

type CompiledSequenceStep = {
  id: string
  matcher: TargetMatcher
  min: number
  max: number
}

export type CompiledPolicy = {
  name: string
  action: 'allow' | 'deny'
  enabled: boolean
  senders: Set<string> | null
  suinsNamePatterns: SuinsNamePattern[] | null
  gasBudgetMax: bigint | null
  allowedCommandKinds: Set<string> | null
  maxCommands: number | null

  // Constraint mode
  targetMatcher: TargetMatcher | null
  callLimits: Map<string, CompiledCallLimit>
  orderingRules: CompiledOrderingRule[]

  // Sequence mode
  sequenceSteps: CompiledSequenceStep[] | null

  // Both modes
  resultFlowRules: CompiledResultFlowRule[]
  typeArguments: Map<string, Map<number, Set<string>>>
}

export type CompiledPolicies = {
  deny: CompiledPolicy[]
  allow: CompiledPolicy[]
  needsSuinsResolution: boolean
}

// ─── Policy Compilation ──────────────────────────────────────────────────────

const compilePolicy = (raw: z.infer<typeof policySchema>): CompiledPolicy => {
  const name = raw.name
  const action = raw.action

  // Target matcher (constraint mode)
  let targetMatcher: TargetMatcher | null = null
  if (raw.targets) {
    targetMatcher = buildTargetMatcher(raw.targets.map(parseTargetPattern))
  }

  // Senders
  const senders = raw.senders
    ? new Set(raw.senders.map((s) => normalizeSuiAddress(s)))
    : null

  // SuiNS name patterns
  const suinsNamePatterns = raw.suinsNames
    ? raw.suinsNames.map(parseSuinsNamePattern)
    : null

  // Call limits
  const callLimits = new Map<string, CompiledCallLimit>()
  if (raw.callLimits) {
    for (const [rawTarget, limit] of Object.entries(raw.callLimits)) {
      const parsed = parseTargetPattern(rawTarget)
      if (parsed.kind !== 'exact') {
        throw new Error(
          `${name}: callLimits keys must be exact targets, got pattern: ${rawTarget}`,
        )
      }
      if (targetMatcher && !matchTarget(parsed.target, targetMatcher)) {
        throw new Error(
          `${name}: callLimits target not in allowed targets: ${rawTarget}`,
        )
      }

      if ('countMatch' in limit) {
        const refParsed = parseTargetPattern(limit.countMatch)
        if (refParsed.kind !== 'exact') {
          throw new Error(
            `${name}: countMatch must reference an exact target: ${limit.countMatch}`,
          )
        }
        if (targetMatcher && !matchTarget(refParsed.target, targetMatcher)) {
          throw new Error(
            `${name}: countMatch target not in allowed targets: ${limit.countMatch}`,
          )
        }
        callLimits.set(parsed.target, {
          kind: 'countMatch',
          target: refParsed.target,
        })
      } else {
        callLimits.set(parsed.target, {
          kind: 'range',
          min: limit.min,
          max: limit.max,
        })
      }
    }

    // No circular countMatch chains
    for (const [target, limit] of callLimits) {
      if (limit.kind === 'countMatch') {
        const ref = callLimits.get(limit.target)
        if (ref && ref.kind === 'countMatch') {
          throw new Error(
            `${name}: circular countMatch chain: ${target} -> ${limit.target}`,
          )
        }
      }
    }
  }

  // Ordering rules
  const orderingRules: CompiledOrderingRule[] = (raw.ordering ?? []).map(
    (rule) => ({
      beforeMatcher: buildTargetMatcher([parseTargetPattern(rule.before)]),
      afterMatcher: buildTargetMatcher([parseTargetPattern(rule.after)]),
    }),
  )

  // Sequence steps
  let sequenceSteps: CompiledSequenceStep[] | null = null
  if (raw.sequence) {
    sequenceSteps = raw.sequence.map((step) => {
      let min: number
      let max: number
      if (step.count !== undefined) {
        min = step.count
        max = step.count
      } else if (step.min !== undefined || step.max !== undefined) {
        min = step.min ?? 0
        max = step.max ?? Infinity
      } else {
        min = 1
        max = 1
      }

      return {
        id: step.id,
        matcher: buildTargetMatcher(step.targets.map(parseTargetPattern)),
        min,
        max,
      }
    })
  }

  // Result flow rules
  const resultFlowRules: CompiledResultFlowRule[] = (
    raw.resultFlow ?? []
  ).map((rule) => ({
    fromMatcher: buildTargetMatcher([parseTargetPattern(rule.from)]),
    toMatcher: buildTargetMatcher(rule.to.map(parseTargetPattern)),
    required: rule.required,
  }))

  // Type arguments
  const typeArguments = new Map<string, Map<number, Set<string>>>()
  if (raw.typeArguments) {
    for (const [rawTarget, argConstraints] of Object.entries(
      raw.typeArguments,
    )) {
      const parsed = parseTargetPattern(rawTarget)
      if (parsed.kind !== 'exact') {
        throw new Error(
          `${name}: typeArguments keys must be exact targets, got: ${rawTarget}`,
        )
      }
      if (targetMatcher && !matchTarget(parsed.target, targetMatcher)) {
        throw new Error(
          `${name}: typeArguments target not in allowed targets: ${rawTarget}`,
        )
      }

      const argMap = new Map<number, Set<string>>()
      for (const [indexStr, allowedTypes] of Object.entries(argConstraints)) {
        const index = Number.parseInt(indexStr, 10)
        if (Number.isNaN(index) || index < 0) {
          throw new Error(
            `${name}: invalid type argument index: ${indexStr}`,
          )
        }
        argMap.set(index, new Set(allowedTypes))
      }
      typeArguments.set(parsed.target, argMap)
    }
  }

  return {
    name,
    action,
    enabled: raw.enabled,
    senders,
    suinsNamePatterns,
    gasBudgetMax:
      raw.gasBudgetMax !== undefined ? BigInt(raw.gasBudgetMax) : null,
    allowedCommandKinds: raw.allowedCommandKinds.includes('*') ? null : new Set(raw.allowedCommandKinds),
    maxCommands: raw.maxCommands ?? null,
    targetMatcher,
    callLimits,
    orderingRules,
    sequenceSteps,
    resultFlowRules,
    typeArguments,
  }
}

export const loadPolicies = (rawConfigs: unknown[]): CompiledPolicies => {
  const parsed = z.array(policySchema).min(1).safeParse(rawConfigs)
  if (!parsed.success) {
    const issue =
      parsed.error.issues[0]?.message ?? 'Invalid policy configuration.'
    throw new Error(`Invalid sponsor policies: ${issue}`)
  }

  const seenNames = new Set<string>()
  const deny: CompiledPolicy[] = []
  const allow: CompiledPolicy[] = []

  for (const raw of parsed.data) {
    if (seenNames.has(raw.name)) {
      throw new Error(`Duplicate sponsor policy name: ${raw.name}`)
    }
    seenNames.add(raw.name)
    const compiled = compilePolicy(raw)
    if (compiled.action === 'deny') {
      deny.push(compiled)
    } else {
      allow.push(compiled)
    }
  }

  const needsSuinsResolution = allow.some((p) => p.suinsNamePatterns !== null)

  return { deny, allow, needsSuinsResolution }
}

// ─── Validation Helpers ──────────────────────────────────────────────────────

type ParsedMoveCall = {
  index: number
  target: string
  arguments: unknown[]
  typeArguments: string[]
}

const getReferencedResultProducerIndex = (argument: unknown): number | null => {
  if (!argument || typeof argument !== 'object') return null

  const parsed = argument as {
    $kind?: string
    Result?: number
    NestedResult?: [number, number]
  }

  if (
    parsed.$kind === 'Result' &&
    typeof parsed.Result === 'number' &&
    Number.isInteger(parsed.Result)
  ) {
    return parsed.Result
  }

  if (
    parsed.$kind === 'NestedResult' &&
    Array.isArray(parsed.NestedResult) &&
    typeof parsed.NestedResult[0] === 'number' &&
    Number.isInteger(parsed.NestedResult[0])
  ) {
    return parsed.NestedResult[0]
  }

  return null
}

const validateConstraintMode = (
  policy: CompiledPolicy,
  moveCalls: ParsedMoveCall[],
): void => {
  const targetMatcher = policy.targetMatcher!

  // Target matching
  for (const mc of moveCalls) {
    if (!matchTarget(mc.target, targetMatcher)) {
      throw new Error(`move call not allowed: ${mc.target}`)
    }
  }

  // Call limits
  if (policy.callLimits.size > 0) {
    const targetCounts = new Map<string, number>()
    for (const mc of moveCalls) {
      targetCounts.set(mc.target, (targetCounts.get(mc.target) ?? 0) + 1)
    }

    for (const [target, limit] of policy.callLimits) {
      const count = targetCounts.get(target) ?? 0
      if (limit.kind === 'range') {
        if (limit.min !== undefined && count < limit.min) {
          throw new Error(
            `${target} called too few times (min ${limit.min}, found ${count})`,
          )
        }
        if (limit.max !== undefined && count > limit.max) {
          throw new Error(
            `${target} called too many times (max ${limit.max}, found ${count})`,
          )
        }
      } else {
        const refCount = targetCounts.get(limit.target) ?? 0
        if (count !== refCount) {
          throw new Error(
            `${target} count (${count}) must match ${limit.target} count (${refCount})`,
          )
        }
      }
    }
  }

  // Ordering
  for (const rule of policy.orderingRules) {
    let lastBeforeIndex = -1
    let firstAfterIndex = Infinity

    for (const mc of moveCalls) {
      if (matchTarget(mc.target, rule.beforeMatcher)) {
        lastBeforeIndex = Math.max(lastBeforeIndex, mc.index)
      }
      if (matchTarget(mc.target, rule.afterMatcher)) {
        firstAfterIndex = Math.min(firstAfterIndex, mc.index)
      }
    }

    if (
      lastBeforeIndex !== -1 &&
      firstAfterIndex !== Infinity &&
      lastBeforeIndex >= firstAfterIndex
    ) {
      throw new Error('ordering constraint violated')
    }
  }
}

const validateSequenceMode = (
  policy: CompiledPolicy,
  moveCalls: ParsedMoveCall[],
): void => {
  const steps = policy.sequenceSteps!
  let callIdx = 0

  for (const step of steps) {
    let matched = 0

    while (
      callIdx < moveCalls.length &&
      matchTarget(moveCalls[callIdx]!.target, step.matcher)
    ) {
      matched++
      callIdx++
      if (matched >= step.max) break
    }

    if (matched < step.min) {
      throw new Error(
        `sequence step "${step.id}" requires at least ${step.min} calls, found ${matched}`,
      )
    }
  }

  if (callIdx < moveCalls.length) {
    throw new Error('unexpected commands after sequence completed')
  }
}

const validateResultFlow = (
  policy: CompiledPolicy,
  moveCalls: ParsedMoveCall[],
): void => {
  if (policy.resultFlowRules.length === 0) return

  const consumersByProducer = new Map<number, string[]>()
  for (const mc of moveCalls) {
    for (const arg of mc.arguments) {
      const producerIndex = getReferencedResultProducerIndex(arg)
      if (producerIndex === null) continue
      const existing = consumersByProducer.get(producerIndex)
      if (existing) {
        existing.push(mc.target)
      } else {
        consumersByProducer.set(producerIndex, [mc.target])
      }
    }
  }

  for (const rule of policy.resultFlowRules) {
    for (const producer of moveCalls) {
      if (!matchTarget(producer.target, rule.fromMatcher)) continue

      const consumers = consumersByProducer.get(producer.index) ?? []
      if (rule.required && consumers.length === 0) {
        throw new Error(`result must be consumed: ${producer.target}`)
      }

      const disallowed = [
        ...new Set(
          consumers.filter((c) => !matchTarget(c, rule.toMatcher)),
        ),
      ]
      if (disallowed.length > 0) {
        throw new Error(
          `result used by disallowed targets: ${disallowed.join(', ')}`,
        )
      }
    }
  }
}

const validateTypeArguments = (
  policy: CompiledPolicy,
  moveCalls: ParsedMoveCall[],
): void => {
  if (policy.typeArguments.size === 0) return

  for (const mc of moveCalls) {
    const constraints = policy.typeArguments.get(mc.target)
    if (!constraints) continue

    for (const [argIndex, allowedTypes] of constraints) {
      const actual = mc.typeArguments[argIndex]
      if (actual === undefined) {
        throw new Error(
          `${mc.target}: missing type argument at index ${argIndex}`,
        )
      }
      if (!allowedTypes.has(actual)) {
        throw new Error(
          `${mc.target}: type argument ${argIndex} not allowed: ${actual}`,
        )
      }
    }
  }
}

// ─── Main Validation ─────────────────────────────────────────────────────────

export const validateSponsoredTxPayload = ({
  txBytesBase64,
  expectedSender,
  expectedSponsor,
  policies,
  senderName,
}: {
  txBytesBase64: string
  expectedSender: string
  expectedSponsor: string
  policies: CompiledPolicies
  senderName?: string | null
}) => {
  const tx = Transaction.from(txBytesBase64)
  const txData = tx.getData()

  if (
    txData.sender &&
    normalizeSuiAddress(txData.sender) !==
      normalizeSuiAddress(expectedSender)
  ) {
    throw new Error('Transaction sender does not match payload sender.')
  }

  if (
    txData.gasData.owner &&
    normalizeSuiAddress(txData.gasData.owner) !==
      normalizeSuiAddress(expectedSponsor)
  ) {
    throw new Error(
      'Transaction gas owner does not match configured sponsor.',
    )
  }

  // Extract move calls once for both deny and allow phases
  const moveCalls: ParsedMoveCall[] = []
  for (const [index, command] of txData.commands.entries()) {
    if (command.$kind === 'MoveCall' && command.MoveCall) {
      const mc = command.MoveCall
      moveCalls.push({
        index,
        target: getMoveCallTarget({
          packageId: mc.package,
          module: mc.module,
          functionName: mc.function,
        }),
        arguments: mc.arguments,
        typeArguments: mc.typeArguments,
      })
    }
  }

  // Phase 1: Deny policies (any-match — reject if ANY call hits a denied target)
  for (const policy of policies.deny) {
    if (!policy.enabled) continue
    if (
      policy.senders &&
      !policy.senders.has(normalizeSuiAddress(expectedSender))
    )
      continue

    // No targets = deny all (scoped by sender if specified)
    if (!policy.targetMatcher) {
      throw new Error(`Transaction denied by policy: ${policy.name}`)
    }

    // Any-match: deny if ANY move call matches a denied target
    const deniedCall = moveCalls.find((mc) =>
      matchTarget(mc.target, policy.targetMatcher!),
    )
    if (deniedCall) {
      throw new Error(
        `Transaction denied by policy: ${policy.name} (matched ${deniedCall.target})`,
      )
    }
  }

  // Phase 2: Allow policies (first-match-wins, all calls must match)
  const policyErrors: string[] = []

  for (const policy of policies.allow) {
    if (!policy.enabled) continue
    if (
      policy.senders &&
      !policy.senders.has(normalizeSuiAddress(expectedSender))
    )
      continue
    if (
      policy.suinsNamePatterns &&
      !matchSuinsName(senderName ?? null, policy.suinsNamePatterns)
    )
      continue
    if (policy.gasBudgetMax !== null && txData.gasData.budget) {
      if (BigInt(txData.gasData.budget) > policy.gasBudgetMax) continue
    }

    try {
      // maxCommands
      if (
        policy.maxCommands !== null &&
        txData.commands.length > policy.maxCommands
      ) {
        throw new Error(`too many commands (max ${policy.maxCommands})`)
      }

      // allowedCommandKinds (null = all allowed)
      if (policy.allowedCommandKinds !== null) {
        for (const command of txData.commands) {
          if (!policy.allowedCommandKinds.has(command.$kind)) {
            throw new Error(`command kind not allowed: ${command.$kind}`)
          }
        }
      }

      if (
        moveCalls.length === 0 &&
        (policy.targetMatcher || policy.sequenceSteps)
      ) {
        throw new Error('must include at least one MoveCall')
      }

      // Constraint mode or Sequence mode
      if (policy.targetMatcher) {
        validateConstraintMode(policy, moveCalls)
      } else if (policy.sequenceSteps) {
        validateSequenceMode(policy, moveCalls)
      }

      // Type arguments
      validateTypeArguments(policy, moveCalls)

      // Result flow
      validateResultFlow(policy, moveCalls)

      return {
        calledTargets: moveCalls.map((mc) => mc.target),
        matchedPolicyName: policy.name,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error'
      policyErrors.push(`${policy.name}: ${message}`)
    }
  }

  throw new Error(
    `Transaction did not match any sponsor policy. ${policyErrors.join(' | ')}`,
  )
}
