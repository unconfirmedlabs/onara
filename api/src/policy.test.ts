import { describe, expect, test } from 'bun:test'
import { Transaction, Inputs } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import defaultPolicy from '../policies/default.json'
import {
  loadPolicies,
  selectPolicyAllowBranch,
  validateSponsoredTxPayload,
  type CompiledPolicies,
  type PolicyEvaluationPlan,
} from './policy'

const SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000001'
const SPONSOR =
  '0x0000000000000000000000000000000000000000000000000000000000000002'
const PKG =
  '0x0000000000000000000000000000000000000000000000000000000000000abc'
const OTHER_PKG =
  '0x0000000000000000000000000000000000000000000000000000000000000def'
const ZERO_DIGEST = '11111111111111111111111111111111'
const CHAIN_ID = '69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD'
function allow(overrides: Record<string, unknown> = {}) {
  return {
    type: 'allow',
    name: 'allow',
    commands: { allowed: ['MoveCall'] },
    calls: {
      mode: 'set',
      rules: [{ id: 'call', targets: [`${PKG}::mod::fn`] }],
    },
    ...overrides,
  }
}

async function buildTxBytes(
  setup: (tx: Transaction) => void,
  opts: {
    sender?: string
    sponsor?: string
    gasBudget?: number | bigint
    gasPayment?: 'addressBalance' | 'coin'
  } = {},
): Promise<string> {
  const tx = new Transaction()
  tx.setSender(opts.sender ?? SENDER)
  tx.setGasOwner(opts.sponsor ?? SPONSOR)
  tx.setGasBudget(opts.gasBudget ?? 10_000_000)
  tx.setGasPrice(1_000)
  tx.setGasPayment(
    opts.gasPayment === 'coin'
      ? [
          {
            objectId:
              '0x0000000000000000000000000000000000000000000000000000000000000000',
            version: '0',
            digest: ZERO_DIGEST,
          },
        ]
      : [],
  )
  tx.setExpiration({
    ValidDuring: {
      minEpoch: '1',
      maxEpoch: '2',
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 1,
    },
  })
  setup(tx)
  return toBase64(await tx.build())
}

function validate(
  txBytesBase64: string,
  policies: CompiledPolicies,
  senderName: string | null = null,
): PolicyEvaluationPlan {
  return validateSponsoredTxPayload({
    txBytesBase64,
    expectedSender: SENDER,
    expectedSponsor: SPONSOR,
    currentEpoch: 1n,
    policies,
    senderName,
  })
}

function branchNames(plan: PolicyEvaluationPlan): string[] {
  return plan.allowBranches.map((branch) => branch.policyName)
}

describe('schema-v1 compilation', () => {
  test('accepts only flat deny and allow policies', () => {
    expect(() => loadPolicies([{ name: 'legacy', targets: ['*'] }])).toThrow()
    expect(() => loadPolicies([allow()])).not.toThrow()
    expect(() =>
      loadPolicies([
        {
          type: 'require',
          name: 'external-authorizer',
          check: {},
        },
      ]),
    ).toThrow()
    expect(() => loadPolicies([allow({ requires: [] })])).toThrow(/requires/)
  })

  test('strictly rejects unknown fields at every policy layer', () => {
    const cases = [
      { ...allow(), action: 'allow' },
      allow({ commands: { allowed: ['MoveCall'], extra: true } }),
      allow({
        calls: {
          mode: 'set',
          rules: [{ id: 'x', targets: ['*'], extra: true }],
        },
      }),
      { type: 'require', name: 'legacy', check: {} },
      { type: 'deny', name: 'd', when: { kind: 'always', targets: ['*'] } },
    ]
    for (const candidate of cases) {
      expect(() => loadPolicies([candidate])).toThrow()
    }
  })

  test('gasBudgetMax is a positive decimal string and retains bigint precision', () => {
    expect(() => loadPolicies([allow({ gasBudgetMax: 10 })])).toThrow(
      /gasBudgetMax/,
    )
    for (const value of ['0', '-1', '+1', '01', '1.0', ' 1']) {
      expect(() => loadPolicies([allow({ gasBudgetMax: value })])).toThrow(
        /gasBudgetMax/,
      )
    }
    const compiled = loadPolicies([
      allow({ gasBudgetMax: '900719925474099300000' }),
    ])
    expect(compiled.allow[0]!.gasBudgetMax).toBe(900719925474099300000n)
  })

  test('rejects duplicate names, values, rules, normalized values, and flow clauses', () => {
    const duplicateCases = [
      [allow(), allow()],
      [allow({ commands: { allowed: ['MoveCall', 'MoveCall'] } })],
      [
        allow({
          senders: ['0x1', SENDER],
        }),
      ],
      [
        allow({
          calls: {
            mode: 'set',
            rules: [
              { id: 'x', targets: [`${PKG}::m::a`] },
              { id: 'x', targets: [`${PKG}::m::b`] },
            ],
          },
        }),
      ],
      [
        allow({
          calls: {
            mode: 'set',
            rules: [
              { id: 'x', targets: ['0xabc::m::a', `${PKG}::m::a`] },
            ],
          },
        }),
      ],
      [
        allow({
          calls: {
            mode: 'set',
            rules: [
              { id: 'a', targets: [`${PKG}::m::a`] },
              { id: 'b', targets: [`${PKG}::m::b`] },
            ],
            resultFlow: [
              {
                from: { rule: 'a', result: 0 },
                to: [{ rule: 'b', argument: 0 }],
              },
              {
                from: { rule: 'a', result: 0 },
                to: [{ rule: 'b', argument: 1 }],
              },
            ],
          },
        }),
      ],
      [
        allow({
          calls: {
            mode: 'set',
            rules: [
              { id: 'a', targets: [`${PKG}::m::a`] },
              { id: 'b', targets: [`${PKG}::m::b`] },
            ],
            resultFlow: [
              {
                from: { rule: 'a', result: 0 },
                to: [
                  { rule: 'b', argument: 0 },
                  { rule: 'b', argument: 0 },
                ],
              },
            ],
          },
        }),
      ],
    ]
    for (const policies of duplicateCases) {
      expect(() => loadPolicies(policies)).toThrow()
    }
  })

  test('rejects overlapping target ownership across local call rules', () => {
    expect(() =>
      loadPolicies([
        allow({
          calls: {
            mode: 'set',
            rules: [
              { id: 'module', targets: [`${PKG}::mod::*`] },
              { id: 'exact', targets: [`${PKG}::mod::fn`] },
            ],
          },
        }),
      ]),
    ).toThrow(/overlapping targets/)
  })

  test('validates local references and cycles', () => {
    expect(() =>
      loadPolicies([
        allow({
          calls: {
            mode: 'set',
            rules: [
              {
                id: 'a',
                targets: [`${PKG}::m::a`],
                count: { sameAs: 'missing' },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/unknown rule/)

    expect(() =>
      loadPolicies([
        allow({
          calls: {
            mode: 'set',
            rules: [
              {
                id: 'a',
                targets: [`${PKG}::m::a`],
                count: { sameAs: 'b' },
              },
              {
                id: 'b',
                targets: [`${PKG}::m::b`],
                count: { sameAs: 'a' },
              },
            ],
          },
        }),
      ]),
    ).toThrow(/circular/)

    expect(() =>
      loadPolicies([
        allow({
          calls: {
            mode: 'sequence',
            rules: [{ id: 'a', targets: [`${PKG}::m::a`] }],
            ordering: [{ before: 'a', after: 'a' }],
          },
        }),
      ]),
    ).toThrow()
  })

})

describe('global transaction invariants and deny override', () => {
  test('rejects GasCoin recursively regardless of allowed command kind', async () => {
    const policies = loadPolicies([
      allow({ commands: { allowed: ['MoveCall', 'TransferObjects'] } }),
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.transferObjects([tx.gas], SENDER)
    })
    expect(() => validate(txBytes, policies)).toThrow(/may not use GasCoin/)
  })

  test('verifies embedded sender and sponsor', async () => {
    const policies = loadPolicies([allow()])
    const wrongSender = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { sender: '0x3' },
    )
    expect(() => validate(wrongSender, policies)).toThrow(/sender does not match/)

    const wrongSponsor = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { sponsor: '0x3' },
    )
    expect(() => validate(wrongSponsor, policies)).toThrow(/gas owner/)
  })

  test('rejects the sponsor as transaction sender', async () => {
    const policies = loadPolicies([allow()])
    const txBytes = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { sender: SPONSOR },
    )
    expect(() =>
      validateSponsoredTxPayload({
        txBytesBase64: txBytes,
        expectedSender: SPONSOR,
        expectedSponsor: SPONSOR,
        currentEpoch: 1n,
        policies,
      }),
    ).toThrow(/cannot be the sponsor/)
  })

  test('requires address-balance gas and rejects explicit gas coin payments', async () => {
    const policies = loadPolicies([allow()])
    const txBytes = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { gasPayment: 'coin' },
    )
    expect(() => validate(txBytes, policies)).toThrow(/address balance/)
  })

  test('requires expiration no later than the next epoch', async () => {
    const policies = loadPolicies([allow()])
    const txBytes = await buildTxBytes((tx) => {
      tx.setExpiration({ Epoch: 3 })
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/expiration exceeds/)
  })

  test('rejects an expiration that has already elapsed', async () => {
    const policies = loadPolicies([allow()])
    const txBytes = await buildTxBytes((tx) => {
      tx.setExpiration({ Epoch: 0 })
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/already elapsed/)
  })

  test('returns de-duplicated owned inputs for RPC ownership authorization', async () => {
    const objectId =
      '0x0000000000000000000000000000000000000000000000000000000000000042'
    const policies = loadPolicies([allow()])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({
        target: `${PKG}::mod::fn`,
        arguments: [
          tx.object(
            Inputs.ObjectRef({ objectId, version: '1', digest: ZERO_DIGEST }),
          ),
        ],
      })
    })
    expect(validate(txBytes, policies).ownedInputIds).toEqual([objectId])
  })

  test('all deny variants override every allow independent of source order', async () => {
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    for (const deny of [
      { type: 'deny', name: 'stop', when: { kind: 'always' } },
      {
        type: 'deny',
        name: 'stop',
        when: { kind: 'sender', addresses: [SENDER] },
      },
      {
        type: 'deny',
        name: 'stop',
        when: { kind: 'any-move-call', targets: [`${PKG}::mod::*`] },
      },
    ]) {
      const policies = loadPolicies([allow(), deny])
      expect(() => validate(txBytes, policies)).toThrow(/denied by policy: stop/)
    }
  })

  test('disabled and nonmatching denies do not block', async () => {
    const policies = loadPolicies([
      {
        type: 'deny',
        name: 'disabled',
        enabled: false,
        when: { kind: 'always' },
      },
      {
        type: 'deny',
        name: 'other',
        when: { kind: 'any-move-call', targets: [`${OTHER_PKG}::*`] },
      },
      allow(),
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(branchNames(validate(txBytes, policies))).toEqual(['allow'])
  })
})

describe('set and sequence call algebra', () => {
  test('set mode allows any order and unconstrained multiplicity when count is absent', async () => {
    const policies = loadPolicies([
      allow({
        calls: {
          mode: 'set',
          rules: [
            { id: 'a', targets: [`${PKG}::m::a`] },
            { id: 'b', targets: [`${PKG}::m::b`] },
          ],
        },
      }),
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::b` })
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::a` })
    })
    expect(branchNames(validate(txBytes, policies))).toEqual(['allow'])
  })

  test('set mode enforces ranges, sameAs, and ordering', async () => {
    const policy = allow({
      calls: {
        mode: 'set',
        rules: [
          {
            id: 'a',
            targets: [`${PKG}::m::a`],
            count: { min: 1, max: 2 },
          },
          {
            id: 'b',
            targets: [`${PKG}::m::b`],
            count: { sameAs: 'a' },
          },
        ],
        ordering: [{ before: 'a', after: 'b' }],
      },
    })
    const policies = loadPolicies([policy])
    const valid = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::b` })
    })
    expect(branchNames(validate(valid, policies))).toEqual(['allow'])

    const wrongOrder = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::b` })
      tx.moveCall({ target: `${PKG}::m::a` })
    })
    expect(() => validate(wrongOrder, policies)).toThrow(/ordering/)

    const wrongCount = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::b` })
    })
    expect(() => validate(wrongCount, policies)).toThrow(/must equal/)
  })

  test('sequence mode defaults each rule to exactly one and supports optional ranges', async () => {
    const policies = loadPolicies([
      allow({
        calls: {
          mode: 'sequence',
          rules: [
            {
              id: 'optional',
              targets: [`${PKG}::m::optional`],
              count: { min: 0, max: 1 },
            },
            { id: 'a', targets: [`${PKG}::m::a`] },
            { id: 'b', targets: [`${PKG}::m::b`] },
          ],
        },
      }),
    ])
    const valid = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::b` })
    })
    expect(branchNames(validate(valid, policies))).toEqual(['allow'])

    const duplicate = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::a` })
      tx.moveCall({ target: `${PKG}::m::b` })
    })
    expect(() => validate(duplicate, policies)).toThrow(/exactly 1/)

    const wrongOrder = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::m::b` })
      tx.moveCall({ target: `${PKG}::m::a` })
    })
    expect(() => validate(wrongOrder, policies)).toThrow(/out-of-sequence/)
  })

  test('target wildcards normalize package addresses', async () => {
    const policies = loadPolicies([
      allow({
        calls: {
          mode: 'set',
          rules: [{ id: 'pkg', targets: ['0xabc::*'] }],
        },
      }),
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::one::a` })
      tx.moveCall({ target: `${PKG}::two::b` })
    })
    expect(branchNames(validate(txBytes, policies))).toEqual(['allow'])
  })

  test('type argument constraints apply to every rule occurrence', async () => {
    const allowedType = `${PKG}::coin::COIN`
    const policies = loadPolicies([
      allow({
        calls: {
          mode: 'set',
          rules: [
            {
              id: 'typed',
              targets: [`${PKG}::m::typed`],
              typeArguments: { '0': [allowedType] },
            },
          ],
        },
      }),
    ])
    const valid = await buildTxBytes((tx) =>
      tx.moveCall({
        target: `${PKG}::m::typed`,
        typeArguments: [allowedType],
      }),
    )
    expect(branchNames(validate(valid, policies))).toEqual(['allow'])
    const wrong = await buildTxBytes((tx) =>
      tx.moveCall({
        target: `${PKG}::m::typed`,
        typeArguments: [`${OTHER_PKG}::coin::COIN`],
      }),
    )
    expect(() => validate(wrong, policies)).toThrow(/not allowed/)
  })

  test('enforces total command kinds/max and per-branch gas caps as selectors', async () => {
    const policies = loadPolicies([
      allow({ name: 'small', gasBudgetMax: '9' }),
      allow({ name: 'large', gasBudgetMax: '10000000' }),
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(branchNames(validate(txBytes, policies))).toEqual(['large'])

    const maxOne = loadPolicies([
      allow({ commands: { allowed: ['MoveCall'], max: 1 } }),
    ])
    const two = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(two, maxOne)).toThrow(/too many commands/)
  })

  test('sender and SuiNS gates select branches without first-match locking', async () => {
    const policies = loadPolicies([
      allow({ name: 'other-sender', senders: ['0x3'] }),
      allow({ name: 'name', suinsNames: ['*.onara.sui'] }),
      allow({ name: 'fallback' }),
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(branchNames(validate(txBytes, policies, 'alice.onara.sui'))).toEqual([
      'name',
      'fallback',
    ])
    expect(branchNames(validate(txBytes, policies, 'onara.sui'))).toEqual([
      'fallback',
    ])
    expect(policies.needsSuinsResolution).toBe(true)
  })
})

function flowPolicy(options: {
  sourceResult?: number
  destinationArgument?: number
  required?: boolean
  producerCount?: { min?: number; max?: number }
  allowedKinds?: string[]
} = {}) {
  return allow({
    commands: {
      allowed: options.allowedKinds ?? ['MoveCall'],
      max: 10,
    },
    calls: {
      mode: 'set',
      rules: [
        {
          id: 'produce',
          targets: [`${PKG}::flow::produce`],
          count: options.producerCount,
        },
        { id: 'consume', targets: [`${PKG}::flow::consume`] },
        { id: 'other', targets: [`${PKG}::flow::other`] },
      ],
      resultFlow: [
        {
          from: { rule: 'produce', result: options.sourceResult ?? 0 },
          to: [
            {
              rule: 'consume',
              argument: options.destinationArgument ?? 0,
            },
          ],
          ...(options.required === undefined
            ? {}
            : { required: options.required }),
        },
      ],
    },
  })
}

describe('exact result-flow graph', () => {
  test('accepts Result as exact slot 0 at the allowed top-level argument', async () => {
    const policies = loadPolicies([flowPolicy()])
    const txBytes = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [produced],
      })
    })
    expect(branchNames(validate(txBytes, policies))).toEqual(['allow'])
  })

  test('accepts NestedResult only for the exact configured slot', async () => {
    const policies = loadPolicies([flowPolicy({ sourceResult: 1 })])
    const valid = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [produced[1]!],
      })
    })
    expect(branchNames(validate(valid, policies))).toEqual(['allow'])

    const wrongSlot = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [produced],
      })
    })
    expect(() => validate(wrongSlot, policies)).toThrow(/must be consumed/)
  })

  test('required defaults true and is enforced for every producer occurrence', async () => {
    const policies = loadPolicies([
      flowPolicy({ producerCount: { min: 2, max: 2 } }),
    ])
    const txBytes = await buildTxBytes((tx) => {
      const first = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [first],
      })
    })
    expect(() => validate(txBytes, policies)).toThrow(/must be consumed/)
  })

  test('required false permits no use but still constrains every actual use', async () => {
    const policies = loadPolicies([flowPolicy({ required: false })])
    const unused = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::flow::produce` }),
    )
    expect(branchNames(validate(unused, policies))).toEqual(['allow'])

    const wrongUse = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::other`,
        arguments: [produced],
      })
    })
    expect(() => validate(wrongUse, policies)).toThrow(/disallowed other/)
  })

  test('rejects a correct consumer rule at the wrong argument index', async () => {
    const policies = loadPolicies([flowPolicy()])
    const txBytes = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [tx.pure.u64(1), produced],
      })
    })
    expect(() => validate(txBytes, policies)).toThrow(/argument 1/)
  })

  test('rejects if any use is disallowed even when another use is allowed', async () => {
    const policies = loadPolicies([flowPolicy()])
    const txBytes = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({
        target: `${PKG}::flow::consume`,
        arguments: [produced],
      })
      tx.moveCall({
        target: `${PKG}::flow::other`,
        arguments: [produced],
      })
    })
    expect(() => validate(txBytes, policies)).toThrow(/disallowed other/)
  })

  test('recursively rejects constrained slots in every argument-bearing native command', async () => {
    const cases: {
      kind: string
      setup: (tx: Transaction, produced: ReturnType<Transaction['moveCall']>) => void
    }[] = [
      {
        kind: 'TransferObjects',
        setup: (tx, produced) =>
          tx.transferObjects([produced], produced),
      },
      {
        kind: 'SplitCoins',
        setup: (tx, produced) => {
          tx.splitCoins(produced, [produced])
        },
      },
      {
        kind: 'MergeCoins',
        setup: (tx, produced) => {
          tx.mergeCoins(produced, [produced])
        },
      },
      {
        kind: 'MakeMoveVec',
        setup: (tx, produced) => {
          tx.makeMoveVec({
            type: `${PKG}::flow::Value`,
            elements: [produced],
          })
        },
      },
      {
        kind: 'Upgrade',
        setup: (tx, produced) => {
          tx.upgrade({
            modules: [[1]],
            dependencies: [],
            package: PKG,
            ticket: produced,
          })
        },
      },
    ]

    for (const fixture of cases) {
      const policies = loadPolicies([
        flowPolicy({
          required: false,
          allowedKinds: ['MoveCall', fixture.kind],
        }),
      ])
      const txBytes = await buildTxBytes((tx) => {
        const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
        fixture.setup(tx, produced)
      })
      expect(() => validate(txBytes, policies), fixture.kind).toThrow(
        /native or non-top-level/,
      )
    }
  })

  test('a flow for slot 1 does not constrain a slot-0 use when optional', async () => {
    const policies = loadPolicies([
      flowPolicy({ sourceResult: 1, required: false }),
    ])
    const txBytes = await buildTxBytes((tx) => {
      const produced = tx.moveCall({ target: `${PKG}::flow::produce` })
      tx.moveCall({ target: `${PKG}::flow::other`, arguments: [produced] })
    })
    expect(branchNames(validate(txBytes, policies))).toEqual(['allow'])
  })
})

describe('allow-branch selection', () => {
  test('synchronous validation returns every complete structural allow branch', async () => {
    const policies = loadPolicies([
      allow({ name: 'first' }),
      allow({ name: 'second' }),
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(branchNames(validate(txBytes, policies))).toEqual(['first', 'second'])
  })

  test('a branch without a SuiNS selector bypasses unnecessary SuiNS work', async () => {
    let nameCalls = 0
    const result = await selectPolicyAllowBranch({
      allowBranches: [
        {
          policyName: 'name-gated',
          suinsNamePatterns: [{ kind: 'wildcard', suffix: '.onara.sui' }],
        },
        { policyName: 'not-name-gated' },
      ],
      resolveSenderName: async () => {
        nameCalls++
        throw new Error('SuiNS unavailable')
      },
    })

    expect(result).toEqual({ status: 'allowed', policyName: 'not-name-gated' })
    expect(nameCalls).toBe(0)
  })

  test('a SuiNS outage is unavailable when no branch can pass', async () => {
    const result = await selectPolicyAllowBranch({
      allowBranches: [
        {
          policyName: 'name-gated',
          suinsNamePatterns: [{ kind: 'wildcard', suffix: '.onara.sui' }],
        },
      ],
      resolveSenderName: async () => {
        throw new Error('SuiNS unavailable')
      },
    })

    expect(result).toEqual({ status: 'unavailable' })
  })

  test('a nonmatching SuiNS name denies the branch', async () => {
    const result = await selectPolicyAllowBranch({
      allowBranches: [
        {
          policyName: 'name-gated',
          suinsNamePatterns: [{ kind: 'exact', name: 'alice.onara.sui' }],
        },
      ],
      resolveSenderName: async () => 'bob.onara.sui',
    })

    expect(result).toEqual({ status: 'denied' })
  })
})

describe('real policy/config integration', () => {
  test('default coin::zero slot-0 flow validates', async () => {
    const policies = loadPolicies([defaultPolicy])
    const txBytes = await buildTxBytes((tx) => {
      const coin = tx.moveCall({
        target: '0x2::coin::zero',
        typeArguments: ['0x2::sui::SUI'],
      })
      tx.moveCall({
        target: '0x2::coin::destroy_zero',
        typeArguments: ['0x2::sui::SUI'],
        arguments: [coin],
      })
    })
    expect(branchNames(validate(txBytes, policies))).toEqual([
      'default-coin-zero-flow',
    ])
  })

})
