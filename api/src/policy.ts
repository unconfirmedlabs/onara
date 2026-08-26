import { z } from 'zod'
import { Transaction } from '@mysten/sui/transactions'
import {
  isValidSuiAddress,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
} from '@mysten/sui/utils'

// Schema-v1 is deliberately a small algebra:
//
//   deny rules override everything
//   allow branches are ORed
//   named requirements inside one allow branch are ANDed
//
// Transaction structure is evaluated synchronously here. External
// requirements are returned as an explicit plan and evaluated by the app.

const COMMAND_KINDS = [
  'MoveCall',
  'TransferObjects',
  'SplitCoins',
  'MergeCoins',
  'MakeMoveVec',
  'Publish',
  'Upgrade',
] as const

export type PolicyCommandKind = (typeof COMMAND_KINDS)[number]

const VISIBLE_ASCII = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/
const DECIMAL_POSITIVE = /^[1-9]\d*$/
const INDEX = /^(0|[1-9]\d*)$/

const unique = <T>(values: readonly T[]): boolean =>
  new Set(values).size === values.length

const namedValueSchema = (field: string) =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(
      VISIBLE_ASCII,
      `${field} must contain only visible ASCII with no leading or trailing whitespace.`,
    )

const uniqueStringsSchema = (field: string, allowEmpty = false) => {
  const schema = z.array(z.string().min(1))
  return (allowEmpty ? schema : schema.min(1)).refine(
    unique,
    `${field} must not contain duplicates.`,
  )
}

const canonicalAddressSchema = z.string().refine(
  (value) =>
    isValidSuiAddress(value) && normalizeSuiAddress(value) === value,
  'Expected a canonical Sui address.',
)

const addressSchema = z
  .string()
  .refine(
    (value) => isValidSuiAddress(normalizeSuiAddress(value)),
    'Expected a valid Sui address.',
  )

const isLocalHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1'

const envVarNameSchema = z
  .string()
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'signingKeyEnv must be a valid environment variable name.',
  )

const dynamicSenderCheckSchema = z
  .object({
    kind: z.literal('sender.dynamic'),
    url: z.string().min(1),
    audience: namedValueSchema('check.audience'),
    signingKeyEnv: envVarNameSchema,
    signingIdentity: canonicalAddressSchema,
    timeoutMs: z.number().int().positive().default(1500),
    cacheTtlSeconds: z
      .number()
      .int()
      .nonnegative()
      .default(0)
      .refine(
        (value) => value === 0 || value >= 60,
        'check.cacheTtlSeconds must be 0 or at least 60.',
      ),
  })
  .strict()
  .refine((check) => {
    try {
      const url = new URL(check.url)
      return (
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && isLocalHostname(url.hostname))
      )
    } catch {
      return false
    }
  }, 'check.url must be https:// (http:// is only allowed for localhost/127.0.0.1).')

export type DynamicSenderCheck = z.infer<typeof dynamicSenderCheckSchema>

const requirePolicySchema = z
  .object({
    type: z.literal('require'),
    name: namedValueSchema('Requirement name'),
    enabled: z.boolean().default(true),
    check: dynamicSenderCheckSchema,
  })
  .strict()

const denyAlwaysSchema = z.object({ kind: z.literal('always') }).strict()
const denyMoveCallSchema = z
  .object({
    kind: z.literal('any-move-call'),
    targets: uniqueStringsSchema('when.targets'),
  })
  .strict()
const denySenderSchema = z
  .object({
    kind: z.literal('sender'),
    addresses: z
      .array(addressSchema)
      .min(1)
      .refine(
        (addresses) => unique(addresses.map((address) => normalizeSuiAddress(address))),
        'when.addresses must not contain duplicate addresses.',
      ),
  })
  .strict()

const denyPolicySchema = z
  .object({
    type: z.literal('deny'),
    name: namedValueSchema('Deny policy name'),
    enabled: z.boolean().default(true),
    when: z.discriminatedUnion('kind', [
      denyAlwaysSchema,
      denyMoveCallSchema,
      denySenderSchema,
    ]),
  })
  .strict()

const countRangeSchema = z
  .object({
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    ({ min, max }) => min !== undefined || max !== undefined,
    'count requires min or max.',
  )
  .refine(
    ({ min, max }) => min === undefined || max === undefined || min <= max,
    'count.min cannot exceed count.max.',
  )

const countSameAsSchema = z
  .object({ sameAs: z.string().min(1) })
  .strict()

const callRuleSchema = z
  .object({
    id: z.string().min(1),
    targets: uniqueStringsSchema('calls.rules.targets'),
    count: z.union([countRangeSchema, countSameAsSchema]).optional(),
    typeArguments: z
      .record(
        z.string().regex(INDEX, 'Expected a non-negative integer index.'),
        uniqueStringsSchema('calls.rules.typeArguments'),
      )
      .optional(),
  })
  .strict()

const orderingSchema = z
  .object({ before: z.string().min(1), after: z.string().min(1) })
  .strict()

const resultConsumerSchema = z
  .object({
    rule: z.string().min(1),
    argument: z.number().int().nonnegative(),
  })
  .strict()

const resultFlowSchema = z
  .object({
    from: z
      .object({
        rule: z.string().min(1),
        result: z.number().int().nonnegative(),
      })
      .strict(),
    to: z.array(resultConsumerSchema).min(1),
    required: z.boolean().default(true),
  })
  .strict()

const setCallsSchema = z
  .object({
    mode: z.literal('set'),
    rules: z.array(callRuleSchema).min(1),
    ordering: z.array(orderingSchema).min(1).optional(),
    resultFlow: z.array(resultFlowSchema).min(1).optional(),
  })
  .strict()

const sequenceCallsSchema = z
  .object({
    mode: z.literal('sequence'),
    rules: z.array(callRuleSchema).min(1),
    resultFlow: z.array(resultFlowSchema).min(1).optional(),
  })
  .strict()

const allowPolicySchema = z
  .object({
    type: z.literal('allow'),
    name: namedValueSchema('Allow policy name'),
    enabled: z.boolean().default(true),
    requires: uniqueStringsSchema('requires', true),
    senders: z
      .array(addressSchema)
      .min(1)
      .refine(
        (addresses) => unique(addresses.map((address) => normalizeSuiAddress(address))),
        'senders must not contain duplicate addresses.',
      )
      .optional(),
    suinsNames: uniqueStringsSchema('suinsNames').optional(),
    gasBudgetMax: z
      .string()
      .regex(DECIMAL_POSITIVE, 'gasBudgetMax must be a positive decimal string.')
      .optional(),
    commands: z
      .object({
        allowed: z
          .array(z.enum(COMMAND_KINDS))
          .min(1)
          .refine(unique, 'commands.allowed must not contain duplicates.'),
        max: z.number().int().positive().optional(),
      })
      .strict(),
    calls: z.discriminatedUnion('mode', [setCallsSchema, sequenceCallsSchema]),
  })
  .strict()

const policySchema = z.discriminatedUnion('type', [
  requirePolicySchema,
  denyPolicySchema,
  allowPolicySchema,
])

// ─── Target patterns ────────────────────────────────────────────────────────

type TargetPattern =
  | { kind: 'universal' }
  | { kind: 'package'; package: string }
  | { kind: 'module'; package: string; module: string }
  | { kind: 'exact'; package: string; module: string; function: string }

type TargetMatcher = { patterns: TargetPattern[] }

const moveIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizePackage(raw: string, original: string): string {
  const normalized = normalizeSuiAddress(raw)
  if (!isValidSuiAddress(normalized)) {
    throw new Error(`Invalid package address in target: ${original}`)
  }
  return normalized
}

function parseTargetPattern(raw: string): TargetPattern {
  if (raw === '*') return { kind: 'universal' }
  if (raw !== raw.trim()) {
    throw new Error(`Target must not contain surrounding whitespace: ${raw}`)
  }
  const parts = raw.split('::')
  if (parts.length === 2 && parts[1] === '*') {
    return { kind: 'package', package: normalizePackage(parts[0]!, raw) }
  }
  if (
    parts.length === 3 &&
    parts[2] === '*' &&
    moveIdentifier.test(parts[1]!)
  ) {
    return {
      kind: 'module',
      package: normalizePackage(parts[0]!, raw),
      module: parts[1]!,
    }
  }
  if (
    parts.length === 3 &&
    moveIdentifier.test(parts[1]!) &&
    moveIdentifier.test(parts[2]!)
  ) {
    return {
      kind: 'exact',
      package: normalizePackage(parts[0]!, raw),
      module: parts[1]!,
      function: parts[2]!,
    }
  }
  throw new Error(`Invalid target pattern format: ${raw}`)
}

function targetPatternKey(pattern: TargetPattern): string {
  switch (pattern.kind) {
    case 'universal':
      return '*'
    case 'package':
      return `${pattern.package}::*`
    case 'module':
      return `${pattern.package}::${pattern.module}::*`
    case 'exact':
      return `${pattern.package}::${pattern.module}::${pattern.function}`
  }
}

function patternsOverlap(a: TargetPattern, b: TargetPattern): boolean {
  if (a.kind === 'universal' || b.kind === 'universal') return true
  if (a.package !== b.package) return false
  if (a.kind === 'package' || b.kind === 'package') return true
  if (a.module !== b.module) return false
  if (a.kind === 'module' || b.kind === 'module') return true
  return a.function === b.function
}

function matchesTarget(target: string, matcher: TargetMatcher): boolean {
  const [pkg, module, fn] = target.split('::')
  return matcher.patterns.some((pattern) => {
    if (pattern.kind === 'universal') return true
    if (pattern.package !== pkg) return false
    if (pattern.kind === 'package') return true
    if (pattern.module !== module) return false
    return pattern.kind === 'module' || pattern.function === fn
  })
}

function getMoveCallTarget(call: {
  package: string
  module: string
  function: string
}): string {
  return `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`
}

// ─── Compiled policies ──────────────────────────────────────────────────────

type CompiledCount =
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'sameAs'; rule: string }

type CompiledCallRule = {
  id: string
  matcher: TargetMatcher
  count: CompiledCount | null
  typeArguments: Map<number, Set<string>>
}

type CompiledResultFlow = {
  from: { rule: string; result: number }
  to: Set<string>
  required: boolean
}

type CompiledCalls = {
  mode: 'set' | 'sequence'
  rules: CompiledCallRule[]
  ordering: { before: string; after: string }[]
  resultFlow: CompiledResultFlow[]
}

export type CompiledRequirement = {
  type: 'require'
  name: string
  enabled: boolean
  check: DynamicSenderCheck
}

export type CompiledDenyPolicy = {
  type: 'deny'
  name: string
  enabled: boolean
  when:
    | { kind: 'always' }
    | { kind: 'any-move-call'; matcher: TargetMatcher }
    | { kind: 'sender'; addresses: Set<string> }
}

export type CompiledAllowPolicy = {
  type: 'allow'
  name: string
  enabled: boolean
  requirementNames: string[]
  requirements: CompiledRequirement[]
  senders: Set<string> | null
  suinsNamePatterns: SuinsNamePattern[] | null
  gasBudgetMax: bigint | null
  allowedCommandKinds: Set<PolicyCommandKind>
  maxCommands: number | null
  calls: CompiledCalls
}

export type CompiledPolicies = {
  require: CompiledRequirement[]
  deny: CompiledDenyPolicy[]
  allow: CompiledAllowPolicy[]
  requirementsByName: Map<string, CompiledRequirement>
  needsSuinsResolution: boolean
}

type SuinsNamePattern =
  | { kind: 'exact'; name: string }
  | { kind: 'wildcard'; suffix: string }

function parseSuinsNamePattern(raw: string): SuinsNamePattern {
  const name = raw.toLowerCase()
  if (name.startsWith('*.')) {
    return { kind: 'wildcard', suffix: name.slice(1) }
  }
  return { kind: 'exact', name }
}

function matchSuinsName(
  name: string | null,
  patterns: SuinsNamePattern[],
): boolean {
  if (name === null) return false
  const normalized = name.toLowerCase()
  return patterns.some((pattern) =>
    pattern.kind === 'exact'
      ? normalized === pattern.name
      : normalized.endsWith(pattern.suffix) &&
        normalized.length > pattern.suffix.length,
  )
}

function compileTargetList(
  rawTargets: string[],
  context: string,
): TargetMatcher {
  const patterns = rawTargets.map(parseTargetPattern)
  const keys = patterns.map(targetPatternKey)
  if (!unique(keys)) {
    throw new Error(`${context}: duplicate normalized target pattern.`)
  }
  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      if (patternsOverlap(patterns[i]!, patterns[j]!)) {
        throw new Error(
          `${context}: overlapping target patterns ${rawTargets[i]} and ${rawTargets[j]}.`,
        )
      }
    }
  }
  return { patterns }
}

function compileCalls(
  raw: z.infer<typeof setCallsSchema> | z.infer<typeof sequenceCallsSchema>,
  policyName: string,
): CompiledCalls {
  const rules: CompiledCallRule[] = raw.rules.map((rule) => {
    const typeArguments = new Map<number, Set<string>>()
    for (const [indexText, rawTypes] of Object.entries(
      rule.typeArguments ?? {},
    )) {
      const normalized = rawTypes.map((type) => normalizeStructTag(type))
      if (!unique(normalized)) {
        throw new Error(
          `${policyName}.${rule.id}: duplicate normalized type argument.`,
        )
      }
      typeArguments.set(Number(indexText), new Set(normalized))
    }

    const count: CompiledCount | null = rule.count
      ? 'sameAs' in rule.count
        ? { kind: 'sameAs', rule: rule.count.sameAs }
        : { kind: 'range', min: rule.count.min, max: rule.count.max }
      : null

    return {
      id: rule.id,
      matcher: compileTargetList(
        rule.targets,
        `${policyName}.calls.rules.${rule.id}`,
      ),
      count,
      typeArguments,
    }
  })

  const ruleIds = rules.map((rule) => rule.id)
  if (!unique(ruleIds)) {
    throw new Error(`${policyName}: duplicate call rule id.`)
  }
  const ruleIdSet = new Set(ruleIds)

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      for (const a of rules[i]!.matcher.patterns) {
        for (const b of rules[j]!.matcher.patterns) {
          if (patternsOverlap(a, b)) {
            throw new Error(
              `${policyName}: overlapping targets in call rules ${rules[i]!.id} and ${rules[j]!.id}.`,
            )
          }
        }
      }
    }
  }

  for (const rule of rules) {
    if (rule.count?.kind === 'sameAs' && !ruleIdSet.has(rule.count.rule)) {
      throw new Error(
        `${policyName}.${rule.id}.count.sameAs references unknown rule ${rule.count.rule}.`,
      )
    }
  }

  const visitState = new Map<string, 'visiting' | 'done'>()
  const visit = (ruleId: string): void => {
    const state = visitState.get(ruleId)
    if (state === 'visiting') {
      throw new Error(`${policyName}: circular count.sameAs chain.`)
    }
    if (state === 'done') return
    visitState.set(ruleId, 'visiting')
    const rule = rules.find((candidate) => candidate.id === ruleId)!
    if (rule.count?.kind === 'sameAs') visit(rule.count.rule)
    visitState.set(ruleId, 'done')
  }
  for (const rule of rules) visit(rule.id)

  const ordering = raw.mode === 'set' ? (raw.ordering ?? []) : []
  const orderingKeys = new Set<string>()
  for (const entry of ordering) {
    if (!ruleIdSet.has(entry.before) || !ruleIdSet.has(entry.after)) {
      throw new Error(`${policyName}: ordering references an unknown call rule.`)
    }
    if (entry.before === entry.after) {
      throw new Error(`${policyName}: ordering cannot reference the same rule.`)
    }
    const key = `${entry.before}\u0000${entry.after}`
    if (orderingKeys.has(key)) {
      throw new Error(`${policyName}: duplicate ordering rule.`)
    }
    orderingKeys.add(key)
  }

  const resultFlow: CompiledResultFlow[] = []
  const sources = new Set<string>()
  for (const flow of raw.resultFlow ?? []) {
    if (!ruleIdSet.has(flow.from.rule)) {
      throw new Error(`${policyName}: resultFlow source references unknown rule.`)
    }
    const source = `${flow.from.rule}\u0000${flow.from.result}`
    if (sources.has(source)) {
      throw new Error(`${policyName}: duplicate resultFlow producer clause.`)
    }
    sources.add(source)

    const destinations = new Set<string>()
    for (const destination of flow.to) {
      if (!ruleIdSet.has(destination.rule)) {
        throw new Error(
          `${policyName}: resultFlow destination references unknown rule.`,
        )
      }
      const key = `${destination.rule}\u0000${destination.argument}`
      if (destinations.has(key)) {
        throw new Error(`${policyName}: duplicate resultFlow destination.`)
      }
      destinations.add(key)
    }
    resultFlow.push({
      from: flow.from,
      to: destinations,
      required: flow.required,
    })
  }

  return { mode: raw.mode, rules, ordering, resultFlow }
}

export function loadPolicies(rawConfigs: unknown[]): CompiledPolicies {
  const parsed = z.array(policySchema).min(1).safeParse(rawConfigs)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : ''
    throw new Error(
      `Invalid sponsor policies: ${path}${issue?.message ?? 'Invalid policy configuration.'}`,
    )
  }

  const names = parsed.data.map((policy) => policy.name)
  if (!unique(names)) throw new Error('Duplicate sponsor policy name.')

  const requirements: CompiledRequirement[] = parsed.data
    .filter((policy): policy is z.infer<typeof requirePolicySchema> =>
      policy.type === 'require',
    )
    .map((policy) => ({ ...policy, type: 'require' as const }))
  const requirementsByName = new Map(
    requirements.map((requirement) => [requirement.name, requirement]),
  )

  const deny: CompiledDenyPolicy[] = parsed.data
    .filter((policy): policy is z.infer<typeof denyPolicySchema> =>
      policy.type === 'deny',
    )
    .map((policy) => {
      let when: CompiledDenyPolicy['when']
      switch (policy.when.kind) {
        case 'always':
          when = { kind: 'always' }
          break
        case 'any-move-call':
          when = {
            kind: 'any-move-call',
            matcher: compileTargetList(
              policy.when.targets,
              `${policy.name}.when.targets`,
            ),
          }
          break
        case 'sender':
          when = {
            kind: 'sender',
            addresses: new Set(
              policy.when.addresses.map((address) => normalizeSuiAddress(address)),
            ),
          }
          break
      }
      return { type: 'deny' as const, name: policy.name, enabled: policy.enabled, when }
    })

  const referencedRequirements = new Set<string>()
  const allow: CompiledAllowPolicy[] = parsed.data
    .filter((policy): policy is z.infer<typeof allowPolicySchema> =>
      policy.type === 'allow',
    )
    .map((policy) => {
      const resolved: CompiledRequirement[] = []
      if (policy.enabled) {
        for (const name of policy.requires) {
          const requirement = requirementsByName.get(name)
          if (!requirement) {
            throw new Error(
              `${policy.name}.requires references unknown requirement ${name}.`,
            )
          }
          if (!requirement.enabled) {
            throw new Error(
              `${policy.name}.requires references disabled requirement ${name}.`,
            )
          }
          resolved.push(requirement)
          referencedRequirements.add(name)
        }
      }

      return {
        type: 'allow' as const,
        name: policy.name,
        enabled: policy.enabled,
        requirementNames: policy.requires,
        requirements: resolved,
        senders: policy.senders
          ? new Set(policy.senders.map((address) => normalizeSuiAddress(address)))
          : null,
        suinsNamePatterns: policy.suinsNames
          ? policy.suinsNames.map(parseSuinsNamePattern)
          : null,
        gasBudgetMax: policy.gasBudgetMax
          ? BigInt(policy.gasBudgetMax)
          : null,
        allowedCommandKinds: new Set(policy.commands.allowed),
        maxCommands: policy.commands.max ?? null,
        calls: compileCalls(policy.calls, policy.name),
      }
    })

  for (const requirement of requirements) {
    if (requirement.enabled && !referencedRequirements.has(requirement.name)) {
      throw new Error(
        `Enabled requirement ${requirement.name} is not referenced by an enabled allow policy.`,
      )
    }
  }

  return {
    require: requirements,
    deny,
    allow,
    requirementsByName,
    needsSuinsResolution: allow.some(
      (policy) => policy.enabled && policy.suinsNamePatterns !== null,
    ),
  }
}

// ─── Transaction validation ─────────────────────────────────────────────────

type ParsedMoveCall = {
  commandIndex: number
  target: string
  arguments: unknown[]
  typeArguments: string[]
}

type MatchedMoveCall = ParsedMoveCall & { rule: CompiledCallRule }

type ResultReference = { producer: number; result: number }

type ResultUse = ResultReference & {
  consumerCommand: number
  consumerKind: string
  consumerRule: string | null
  argument: number | null
  topLevelArgument: boolean
}

function parseResultReference(value: unknown): ResultReference | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const argument = value as {
    $kind?: unknown
    Result?: unknown
    NestedResult?: unknown
  }
  if (
    argument.$kind === 'Result' &&
    Number.isInteger(argument.Result) &&
    (argument.Result as number) >= 0
  ) {
    return { producer: argument.Result as number, result: 0 }
  }
  if (
    argument.$kind === 'NestedResult' &&
    Array.isArray(argument.NestedResult) &&
    argument.NestedResult.length === 2 &&
    Number.isInteger(argument.NestedResult[0]) &&
    Number.isInteger(argument.NestedResult[1]) &&
    argument.NestedResult[0] >= 0 &&
    argument.NestedResult[1] >= 0
  ) {
    return {
      producer: argument.NestedResult[0],
      result: argument.NestedResult[1],
    }
  }
  return null
}

function collectReferences(value: unknown, output: ResultReference[]): void {
  const direct = parseResultReference(value)
  if (direct) {
    output.push(direct)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectReferences(item, output)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      collectReferences(child, output)
    }
  }
}

function referencesGasCoin(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(referencesGasCoin)
  const record = value as Record<string, unknown>
  if (record.$kind === 'GasCoin' || record.GasCoin === true) return true
  return Object.values(record).some(referencesGasCoin)
}

function assertRuleTypeArguments(
  policyName: string,
  call: ParsedMoveCall,
  rule: CompiledCallRule,
): void {
  for (const [index, allowed] of rule.typeArguments) {
    const actual = call.typeArguments[index]
    if (actual === undefined) {
      throw new Error(
        `${policyName}.${rule.id}: missing type argument at index ${index}.`,
      )
    }
    if (!allowed.has(actual)) {
      throw new Error(
        `${policyName}.${rule.id}: type argument ${index} is not allowed: ${actual}.`,
      )
    }
  }
}

function validateCount(
  policyName: string,
  rule: CompiledCallRule,
  count: number,
  counts: ReadonlyMap<string, number>,
  mode: 'set' | 'sequence',
): void {
  if (rule.count === null) {
    if (mode === 'sequence' && count !== 1) {
      throw new Error(
        `${policyName}.${rule.id}: expected exactly 1 call, found ${count}.`,
      )
    }
    return
  }
  if (rule.count.kind === 'sameAs') {
    const expected = counts.get(rule.count.rule) ?? 0
    if (count !== expected) {
      throw new Error(
        `${policyName}.${rule.id}: call count ${count} must equal ${rule.count.rule} count ${expected}.`,
      )
    }
    return
  }
  if (rule.count.min !== undefined && count < rule.count.min) {
    throw new Error(
      `${policyName}.${rule.id}: expected at least ${rule.count.min} calls, found ${count}.`,
    )
  }
  if (rule.count.max !== undefined && count > rule.count.max) {
    throw new Error(
      `${policyName}.${rule.id}: expected at most ${rule.count.max} calls, found ${count}.`,
    )
  }
}

function matchCalls(
  policy: CompiledAllowPolicy,
  moveCalls: ParsedMoveCall[],
): MatchedMoveCall[] {
  const matched: MatchedMoveCall[] = []
  const counts = new Map(policy.calls.rules.map((rule) => [rule.id, 0]))

  if (policy.calls.mode === 'set') {
    for (const call of moveCalls) {
      const rule = policy.calls.rules.find((candidate) =>
        matchesTarget(call.target, candidate.matcher),
      )
      if (!rule) throw new Error(`move call not allowed: ${call.target}`)
      assertRuleTypeArguments(policy.name, call, rule)
      counts.set(rule.id, counts.get(rule.id)! + 1)
      matched.push({ ...call, rule })
    }
  } else {
    let callIndex = 0
    for (const rule of policy.calls.rules) {
      while (
        callIndex < moveCalls.length &&
        matchesTarget(moveCalls[callIndex]!.target, rule.matcher)
      ) {
        const call = moveCalls[callIndex]!
        assertRuleTypeArguments(policy.name, call, rule)
        counts.set(rule.id, counts.get(rule.id)! + 1)
        matched.push({ ...call, rule })
        callIndex++
      }
    }
    if (callIndex !== moveCalls.length) {
      throw new Error(
        `unexpected or out-of-sequence move call: ${moveCalls[callIndex]!.target}`,
      )
    }
  }

  for (const rule of policy.calls.rules) {
    validateCount(
      policy.name,
      rule,
      counts.get(rule.id)!,
      counts,
      policy.calls.mode,
    )
  }

  for (const ordering of policy.calls.ordering) {
    const before = matched
      .filter((call) => call.rule.id === ordering.before)
      .map((call) => call.commandIndex)
    const after = matched
      .filter((call) => call.rule.id === ordering.after)
      .map((call) => call.commandIndex)
    if (
      before.length > 0 &&
      after.length > 0 &&
      Math.max(...before) >= Math.min(...after)
    ) {
      throw new Error(
        `${policy.name}: ordering ${ordering.before} before ${ordering.after} violated.`,
      )
    }
  }

  return matched
}

function collectResultUses(
  commands: readonly unknown[],
  matchedCalls: MatchedMoveCall[],
): ResultUse[] {
  const ruleByCommand = new Map(
    matchedCalls.map((call) => [call.commandIndex, call.rule.id]),
  )
  const uses: ResultUse[] = []

  for (const [commandIndex, rawCommand] of commands.entries()) {
    const command = rawCommand as {
      $kind?: string
      MoveCall?: { arguments?: unknown[] }
    }
    if (
      command.$kind === 'MoveCall' &&
      command.MoveCall &&
      Array.isArray(command.MoveCall.arguments)
    ) {
      for (const [argument, value] of command.MoveCall.arguments.entries()) {
        const references: ResultReference[] = []
        collectReferences(value, references)
        const direct = parseResultReference(value)
        for (const reference of references) {
          uses.push({
            ...reference,
            consumerCommand: commandIndex,
            consumerKind: 'MoveCall',
            consumerRule: ruleByCommand.get(commandIndex) ?? null,
            argument,
            topLevelArgument:
              direct !== null &&
              direct.producer === reference.producer &&
              direct.result === reference.result,
          })
        }
      }
      continue
    }

    const references: ResultReference[] = []
    collectReferences(rawCommand, references)
    for (const reference of references) {
      uses.push({
        ...reference,
        consumerCommand: commandIndex,
        consumerKind: command.$kind ?? 'Unknown',
        consumerRule: null,
        argument: null,
        topLevelArgument: false,
      })
    }
  }

  return uses
}

function validateResultFlow(
  policy: CompiledAllowPolicy,
  commands: readonly unknown[],
  matchedCalls: MatchedMoveCall[],
): void {
  if (policy.calls.resultFlow.length === 0) return
  const uses = collectResultUses(commands, matchedCalls)

  for (const flow of policy.calls.resultFlow) {
    const producers = matchedCalls.filter(
      (call) => call.rule.id === flow.from.rule,
    )
    for (const producer of producers) {
      const actualUses = uses.filter(
        (use) =>
          use.producer === producer.commandIndex &&
          use.result === flow.from.result,
      )
      if (flow.required && actualUses.length === 0) {
        throw new Error(
          `${policy.name}.${flow.from.rule}[${flow.from.result}]: result must be consumed.`,
        )
      }
      for (const use of actualUses) {
        if (
          use.consumerKind !== 'MoveCall' ||
          !use.topLevelArgument ||
          use.consumerRule === null ||
          use.argument === null
        ) {
          throw new Error(
            `${policy.name}.${flow.from.rule}[${flow.from.result}]: constrained result has a native or non-top-level consumer.`,
          )
        }
        const destination = `${use.consumerRule}\u0000${use.argument}`
        if (!flow.to.has(destination)) {
          throw new Error(
            `${policy.name}.${flow.from.rule}[${flow.from.result}]: result used by disallowed ${use.consumerRule} argument ${use.argument}.`,
          )
        }
      }
    }
  }
}

function validateAllowPolicy(
  policy: CompiledAllowPolicy,
  commands: readonly unknown[],
  moveCalls: ParsedMoveCall[],
): void {
  if (policy.maxCommands !== null && commands.length > policy.maxCommands) {
    throw new Error(`too many commands (max ${policy.maxCommands}).`)
  }
  for (const rawCommand of commands) {
    const kind = (rawCommand as { $kind?: string }).$kind
    if (!kind || !policy.allowedCommandKinds.has(kind as PolicyCommandKind)) {
      throw new Error(`command kind not allowed: ${kind ?? 'Unknown'}.`)
    }
  }
  if (moveCalls.length === 0) {
    throw new Error('must include at least one MoveCall.')
  }
  const matched = matchCalls(policy, moveCalls)
  validateResultFlow(policy, commands, matched)
}

export type PolicyAllowBranch = {
  policyName: string
  requirements: CompiledRequirement[]
}

export type PolicyEvaluationPlan = {
  calledTargets: string[]
  ownedInputIds: string[]
  allowBranches: PolicyAllowBranch[]
}

export function validateSponsoredTxPayload({
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
}): PolicyEvaluationPlan {
  const tx = Transaction.from(txBytesBase64)
  const txData = tx.getData()

  if (!txData.sender) {
    throw new Error('Sponsored transaction is missing its sender.')
  }
  if (
    normalizeSuiAddress(txData.sender) !== normalizeSuiAddress(expectedSender)
  ) {
    throw new Error('Transaction sender does not match payload sender.')
  }
  if (!txData.gasData.owner) {
    throw new Error('Sponsored transaction is missing its gas owner.')
  }
  if (
    normalizeSuiAddress(txData.gasData.owner) !==
    normalizeSuiAddress(expectedSponsor)
  ) {
    throw new Error(
      'Transaction gas owner does not match configured sponsor.',
    )
  }

  const ownedInputIds: string[] = []
  for (const input of txData.inputs) {
    if (input.$kind === 'FundsWithdrawal') {
      if (input.FundsWithdrawal.withdrawFrom.$kind !== 'Sender') {
        throw new Error('Sponsored transactions may only withdraw sender funds.')
      }
      continue
    }
    if (
      input.$kind === 'Object' &&
      input.Object.$kind === 'ImmOrOwnedObject'
    ) {
      ownedInputIds.push(
        normalizeSuiObjectId(input.Object.ImmOrOwnedObject.objectId),
      )
    }
  }

  if (txData.commands.some(referencesGasCoin)) {
    throw new Error('Sponsored transaction commands may not use GasCoin.')
  }

  const moveCalls: ParsedMoveCall[] = []
  for (const [commandIndex, command] of txData.commands.entries()) {
    if (command.$kind !== 'MoveCall' || !command.MoveCall) continue
    moveCalls.push({
      commandIndex,
      target: getMoveCallTarget(command.MoveCall),
      arguments: command.MoveCall.arguments,
      typeArguments: command.MoveCall.typeArguments.map((type) =>
        normalizeStructTag(type),
      ),
    })
  }
  const calledTargets = moveCalls.map((call) => call.target)
  const normalizedSender = normalizeSuiAddress(expectedSender)

  for (const policy of policies.deny) {
    if (!policy.enabled) continue
    let denied = false
    switch (policy.when.kind) {
      case 'always':
        denied = true
        break
      case 'sender':
        denied = policy.when.addresses.has(normalizedSender)
        break
      case 'any-move-call':
        const matcher = policy.when.matcher
        denied = moveCalls.some((call) =>
          matchesTarget(call.target, matcher),
        )
        break
    }
    if (denied) throw new Error(`Transaction denied by policy: ${policy.name}.`)
  }

  const errors: string[] = []
  const allowBranches: PolicyAllowBranch[] = []
  for (const policy of policies.allow) {
    if (!policy.enabled) continue
    if (policy.senders && !policy.senders.has(normalizedSender)) continue
    if (
      policy.suinsNamePatterns &&
      !matchSuinsName(senderName ?? null, policy.suinsNamePatterns)
    ) {
      continue
    }
    if (policy.gasBudgetMax !== null) {
      if (
        txData.gasData.budget == null ||
        BigInt(txData.gasData.budget) > policy.gasBudgetMax
      ) {
        continue
      }
    }

    try {
      validateAllowPolicy(policy, txData.commands, moveCalls)
      allowBranches.push({
        policyName: policy.name,
        requirements: policy.requirements,
      })
    } catch (error) {
      errors.push(
        `${policy.name}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
    }
  }

  if (allowBranches.length === 0) {
    throw new Error(
      `Transaction did not match any allow policy.${errors.length ? ` ${errors.join(' | ')}` : ''}`,
    )
  }

  return {
    calledTargets,
    ownedInputIds: [...new Set(ownedInputIds)],
    allowBranches,
  }
}

// ─── Requirement algebra ────────────────────────────────────────────────────

export type RequirementDecision = 'allow' | 'deny' | 'unavailable'

export type AuthorizationDecision =
  | { status: 'allowed'; policyName: string }
  | { status: 'denied' }
  | { status: 'unavailable' }

export async function evaluatePolicyRequirements({
  allowBranches,
  evaluate,
}: {
  allowBranches: readonly PolicyAllowBranch[]
  evaluate: (input: {
    requirement: CompiledRequirement
    policyName: string
  }) => Promise<RequirementDecision>
}): Promise<AuthorizationDecision> {
  let sawUnavailable = false

  for (const branch of allowBranches) {
    let branchUnavailable = false
    let branchDenied = false

    for (const requirement of branch.requirements) {
      const decision = await evaluate({
        requirement,
        policyName: branch.policyName,
      })
      if (decision === 'deny') {
        branchDenied = true
        break
      }
      if (decision === 'unavailable') branchUnavailable = true
    }

    if (!branchDenied && !branchUnavailable) {
      return { status: 'allowed', policyName: branch.policyName }
    }
    if (!branchDenied && branchUnavailable) sawUnavailable = true
  }

  return sawUnavailable ? { status: 'unavailable' } : { status: 'denied' }
}
