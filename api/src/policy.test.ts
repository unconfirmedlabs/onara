import { describe, expect, test } from 'bun:test'
import { Transaction } from '@mysten/sui/transactions'
import { toBase64 } from '@mysten/sui/utils'
import { loadPolicies, validateSponsoredTxPayload, type CompiledPolicies } from './policy'

// ─── Constants ────────────────────────────────────────────────────────────────

const SENDER = '0x0000000000000000000000000000000000000000000000000000000000000001'
const SPONSOR = '0x0000000000000000000000000000000000000000000000000000000000000002'
const PKG = '0x0000000000000000000000000000000000000000000000000000000000000abc'
const SUI_PKG = '0x0000000000000000000000000000000000000000000000000000000000000002'

// base58-encoded 32-byte zero digest
const ZERO_DIGEST = '11111111111111111111111111111111'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function buildTxBytes(
  setup: (tx: Transaction) => void,
  opts?: { sender?: string; sponsor?: string; gasBudget?: number },
): Promise<string> {
  const sender = opts?.sender ?? SENDER
  const sponsor = opts?.sponsor ?? SPONSOR
  const gasBudget = opts?.gasBudget ?? 10_000_000

  const tx = new Transaction()
  tx.setSender(sender)
  tx.setGasOwner(sponsor)
  tx.setGasBudget(gasBudget)
  tx.setGasPrice(1000)
  tx.setGasPayment([
    {
      objectId: '0x0000000000000000000000000000000000000000000000000000000000000000',
      version: '0',
      digest: ZERO_DIGEST,
    },
  ])

  setup(tx)

  const bytes = await tx.build()
  return toBase64(bytes)
}

function validate(
  txBytes: string,
  policies: CompiledPolicies,
  opts?: { sender?: string; sponsor?: string; senderName?: string | null },
) {
  return validateSponsoredTxPayload({
    txBytesBase64: txBytes,
    expectedSender: opts?.sender ?? SENDER,
    expectedSponsor: opts?.sponsor ?? SPONSOR,
    policies,
    senderName: opts?.senderName,
  })
}

// ─── loadPolicies — schema validation ─────────────────────────────────────────

describe('loadPolicies', () => {
  test('rejects config with neither targets nor sequence', () => {
    expect(() =>
      loadPolicies([{ name: 'bad', allowedCommandKinds: ['MoveCall'] }]),
    ).toThrow()
  })

  test('rejects config with both targets and sequence', () => {
    expect(() =>
      loadPolicies([
        {
          name: 'bad',
          targets: [`${PKG}::mod::fn`],
          sequence: [{ id: 'step1', targets: [`${PKG}::mod::fn`] }],
        },
      ]),
    ).toThrow()
  })

  test('rejects callLimits in sequence mode', () => {
    expect(() =>
      loadPolicies([
        {
          name: 'bad',
          sequence: [{ id: 'step1', targets: [`${PKG}::mod::fn`] }],
          callLimits: { [`${PKG}::mod::fn`]: { min: 1 } },
        },
      ]),
    ).toThrow()
  })

  test('rejects duplicate policy names', () => {
    expect(() =>
      loadPolicies([
        { name: 'dup', targets: [`${PKG}::mod::fn`] },
        { name: 'dup', targets: [`${PKG}::mod::fn`] },
      ]),
    ).toThrow(/Duplicate/)
  })

  test('rejects callLimits target not in targets', () => {
    expect(() =>
      loadPolicies([
        {
          name: 'bad',
          targets: [`${PKG}::mod::fn`],
          callLimits: { [`${PKG}::mod::other`]: { min: 1 } },
        },
      ]),
    ).toThrow(/not in allowed targets/)
  })

  test('rejects circular countMatch chain', () => {
    expect(() =>
      loadPolicies([
        {
          name: 'bad',
          targets: [`${PKG}::mod::a`, `${PKG}::mod::b`],
          callLimits: {
            [`${PKG}::mod::a`]: { countMatch: `${PKG}::mod::b` },
            [`${PKG}::mod::b`]: { countMatch: `${PKG}::mod::a` },
          },
        },
      ]),
    ).toThrow(/circular/)
  })
})

// ─── Security checks ─────────────────────────────────────────────────────────

describe('security checks', () => {
  test('rejects tx where embedded sender ≠ expected sender', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { sender: SENDER },
    )
    expect(() =>
      validate(txBytes, policies, {
        sender: '0x0000000000000000000000000000000000000000000000000000000000000099',
      }),
    ).toThrow(/sender/)
  })

  test('rejects tx where embedded gas owner ≠ expected sponsor', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { sponsor: SPONSOR },
    )
    expect(() =>
      validate(txBytes, policies, {
        sponsor: '0x0000000000000000000000000000000000000000000000000000000000000099',
      }),
    ).toThrow(/gas owner/)
  })
})

// ─── Constraint mode ──────────────────────────────────────────────────────────

describe('constraint mode', () => {
  test('accepts valid tx matching exact targets', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    const result = validate(txBytes, policies)
    expect(result.matchedPolicyName).toBe('p')
  })

  test('rejects disallowed target', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::evil` }),
    )
    expect(() => validate(txBytes, policies)).toThrow(/not allowed/)
  })

  test('rejects too many commands (maxCommands)', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`], maxCommands: 1 },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/too many commands/)
  })

  test('rejects non-MoveCall command (allowedCommandKinds)', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.transferObjects([tx.gas], SENDER)
    })
    expect(() => validate(txBytes, policies)).toThrow(/command kind not allowed/)
  })

  test('enforces callLimits min', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::fn`],
        callLimits: { [`${PKG}::mod::fn`]: { min: 2 } },
      },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(() => validate(txBytes, policies)).toThrow(/too few times/)
  })

  test('enforces callLimits max', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::fn`],
        callLimits: { [`${PKG}::mod::fn`]: { max: 1 } },
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/too many times/)
  })

  test('enforces countMatch (matching count passes; mismatch rejects)', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::a`, `${PKG}::mod::b`],
        callLimits: {
          [`${PKG}::mod::a`]: { countMatch: `${PKG}::mod::b` },
        },
      },
    ])

    // Matching counts — should pass
    const txBytesPass = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::a` })
      tx.moveCall({ target: `${PKG}::mod::b` })
    })
    expect(validate(txBytesPass, policies).matchedPolicyName).toBe('p')

    // Mismatching counts — should fail
    const txBytesFail = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::a` })
      tx.moveCall({ target: `${PKG}::mod::b` })
      tx.moveCall({ target: `${PKG}::mod::b` })
    })
    expect(() => validate(txBytesFail, policies)).toThrow(/count.*must match/)
  })

  test('enforces ordering (correct order passes; wrong order rejects)', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::first`, `${PKG}::mod::second`],
        ordering: [
          { before: `${PKG}::mod::first`, after: `${PKG}::mod::second` },
        ],
      },
    ])

    // Correct order
    const txBytesPass = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::first` })
      tx.moveCall({ target: `${PKG}::mod::second` })
    })
    expect(validate(txBytesPass, policies).matchedPolicyName).toBe('p')

    // Wrong order
    const txBytesFail = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::second` })
      tx.moveCall({ target: `${PKG}::mod::first` })
    })
    expect(() => validate(txBytesFail, policies)).toThrow(/ordering/)
  })
})

// ─── Wildcards ────────────────────────────────────────────────────────────────

describe('wildcards', () => {
  test('module wildcard matches any function in module', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::mod::*`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::any_function` }),
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('p')
  })

  test('package wildcard matches any module/function', async () => {
    const policies = loadPolicies([
      { name: 'p', targets: [`${PKG}::*`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::any_mod::any_fn` }),
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('p')
  })
})

// ─── Sequence mode ────────────────────────────────────────────────────────────

describe('sequence mode', () => {
  test('accepts valid sequence', async () => {
    const policies = loadPolicies([
      {
        name: 'seq',
        sequence: [
          { id: 'step1', targets: [`${PKG}::mod::a`] },
          { id: 'step2', targets: [`${PKG}::mod::b`] },
        ],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::a` })
      tx.moveCall({ target: `${PKG}::mod::b` })
    })
    expect(validate(txBytes, policies).matchedPolicyName).toBe('seq')
  })

  test('rejects too few calls for a step', async () => {
    const policies = loadPolicies([
      {
        name: 'seq',
        sequence: [
          { id: 'step1', targets: [`${PKG}::mod::a`], count: 2 },
          { id: 'step2', targets: [`${PKG}::mod::b`] },
        ],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::a` })
      tx.moveCall({ target: `${PKG}::mod::b` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/at least/)
  })

  test('rejects extra calls after sequence ends', async () => {
    const policies = loadPolicies([
      {
        name: 'seq',
        sequence: [{ id: 'step1', targets: [`${PKG}::mod::a`] }],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::a` })
      tx.moveCall({ target: `${PKG}::mod::a` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/unexpected commands/)
  })
})

// ─── Result flow ──────────────────────────────────────────────────────────────

describe('result flow', () => {
  test('accepts result consumed by allowed target', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::produce`, `${PKG}::mod::consume`],
        resultFlow: [
          {
            from: `${PKG}::mod::produce`,
            to: [`${PKG}::mod::consume`],
            required: true,
          },
        ],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      const result = tx.moveCall({ target: `${PKG}::mod::produce` })
      tx.moveCall({
        target: `${PKG}::mod::consume`,
        arguments: [result],
      })
    })
    expect(validate(txBytes, policies).matchedPolicyName).toBe('p')
  })

  test('rejects unconsumed result when required: true', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::produce`, `${PKG}::mod::consume`],
        resultFlow: [
          {
            from: `${PKG}::mod::produce`,
            to: [`${PKG}::mod::consume`],
            required: true,
          },
        ],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::produce` })
      tx.moveCall({ target: `${PKG}::mod::consume` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/result must be consumed/)
  })

  test('rejects result consumed by disallowed target', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${PKG}::mod::produce`, `${PKG}::mod::ok`, `${PKG}::mod::bad`],
        resultFlow: [
          {
            from: `${PKG}::mod::produce`,
            to: [`${PKG}::mod::ok`],
            required: false,
          },
        ],
      },
    ])
    const txBytes = await buildTxBytes((tx) => {
      const result = tx.moveCall({ target: `${PKG}::mod::produce` })
      tx.moveCall({
        target: `${PKG}::mod::bad`,
        arguments: [result],
      })
    })
    expect(() => validate(txBytes, policies)).toThrow(/disallowed/)
  })
})

// ─── Type arguments ───────────────────────────────────────────────────────────

describe('type arguments', () => {
  const SUI_TYPE = `${SUI_PKG}::sui::SUI`

  test('accepts correct type argument', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${SUI_PKG}::coin::zero`],
        typeArguments: {
          [`${SUI_PKG}::coin::zero`]: { '0': [SUI_TYPE] },
        },
      },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({
        target: `${SUI_PKG}::coin::zero`,
        typeArguments: [SUI_TYPE],
      }),
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('p')
  })

  test('rejects wrong type argument', async () => {
    const policies = loadPolicies([
      {
        name: 'p',
        targets: [`${SUI_PKG}::coin::zero`],
        typeArguments: {
          [`${SUI_PKG}::coin::zero`]: { '0': [SUI_TYPE] },
        },
      },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({
        target: `${SUI_PKG}::coin::zero`,
        typeArguments: [`${PKG}::fake::FAKE`],
      }),
    )
    expect(() => validate(txBytes, policies)).toThrow(/type argument.*not allowed/)
  })
})

// ─── Soft skips ───────────────────────────────────────────────────────────────

describe('soft skips', () => {
  test('skips disabled policy, falls through to enabled one', async () => {
    const policies = loadPolicies([
      { name: 'disabled', enabled: false, targets: [`${PKG}::mod::fn`] },
      { name: 'enabled', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('enabled')
  })

  test('skips policy with sender restriction, falls through', async () => {
    const otherSender = '0x0000000000000000000000000000000000000000000000000000000000000099'
    const policies = loadPolicies([
      { name: 'restricted', targets: [`${PKG}::mod::fn`], senders: [otherSender] },
      { name: 'open', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes((tx) =>
      tx.moveCall({ target: `${PKG}::mod::fn` }),
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('open')
  })

  test('skips policy with gas budget exceeded, falls through', async () => {
    const policies = loadPolicies([
      { name: 'tight', targets: [`${PKG}::mod::fn`], gasBudgetMax: 1_000 },
      { name: 'generous', targets: [`${PKG}::mod::fn`] },
    ])
    const txBytes = await buildTxBytes(
      (tx) => tx.moveCall({ target: `${PKG}::mod::fn` }),
      { gasBudget: 10_000_000 },
    )
    expect(validate(txBytes, policies).matchedPolicyName).toBe('generous')
  })
})

// ─── Default policy integration ───────────────────────────────────────────────

describe('default policy integration', () => {
  test('loads policies/default.json, validates coin::zero → coin::destroy_zero flow', async () => {
    const defaultConfig = await import('../policies/default.json')
    const policies = loadPolicies([defaultConfig.default ?? defaultConfig])

    const txBytes = await buildTxBytes((tx) => {
      const coin = tx.moveCall({
        target: `${SUI_PKG}::coin::zero`,
        typeArguments: [`${SUI_PKG}::sui::SUI`],
      })
      tx.moveCall({
        target: `${SUI_PKG}::coin::destroy_zero`,
        arguments: [coin],
        typeArguments: [`${SUI_PKG}::sui::SUI`],
      })
    })

    const result = validate(txBytes, policies)
    expect(result.matchedPolicyName).toBe('default-coin-zero-flow')
    expect(result.calledTargets).toEqual([
      `${SUI_PKG}::coin::zero`,
      `${SUI_PKG}::coin::destroy_zero`,
    ])
  })
})

// ─── Universal wildcard ───────────────────────────────────────────────────────

describe('allow-all policy (universal wildcard)', () => {
  test('targets: ["*"] matches any transaction', async () => {
    const policies = loadPolicies([{ name: 'allow-all', targets: ['*'] }])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::my_module::my_function` })
    })
    const result = validate(txBytes, policies)
    expect(result.matchedPolicyName).toBe('allow-all')
  })

  test('targets: ["*"] matches multiple calls to different packages', async () => {
    const policies = loadPolicies([{ name: 'allow-all', targets: ['*'] }])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod_a::fn_a` })
      tx.moveCall({ target: `${SUI_PKG}::coin::zero` })
    })
    const result = validate(txBytes, policies)
    expect(result.matchedPolicyName).toBe('allow-all')
    expect(result.calledTargets).toHaveLength(2)
  })
})

// ─── Deny policies ───────────────────────────────────────────────────────────

const BAD_PKG = '0x0000000000000000000000000000000000000000000000000000000000000bad'

describe('deny policies', () => {
  test('deny by target blocks matching transaction', async () => {
    const policies = loadPolicies([
      { name: 'block-bad', action: 'deny', targets: [`${BAD_PKG}::*`] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${BAD_PKG}::exploit::drain` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/denied by policy: block-bad/)
  })

  test('deny by sender blocks matching sender', async () => {
    const policies = loadPolicies([
      { name: 'block-sender', action: 'deny', senders: [SENDER] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/denied by policy: block-sender/)
  })

  test('deny by sender does not affect other senders', async () => {
    const otherSender = '0x0000000000000000000000000000000000000000000000000000000000000099'
    const policies = loadPolicies([
      { name: 'block-sender', action: 'deny', senders: [SENDER] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes(
      (tx) => { tx.moveCall({ target: `${PKG}::mod::fn` }) },
      { sender: otherSender },
    )
    const result = validate(txBytes, policies, { sender: otherSender })
    expect(result.matchedPolicyName).toBe('allow-all')
  })

  test('deny does not affect non-matching targets', async () => {
    const policies = loadPolicies([
      { name: 'block-bad', action: 'deny', targets: [`${BAD_PKG}::*`] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    const result = validate(txBytes, policies)
    expect(result.matchedPolicyName).toBe('allow-all')
  })

  test('deny fires even when allow-all is listed first in config', async () => {
    const policies = loadPolicies([
      { name: 'allow-all', targets: ['*'] },
      { name: 'block-bad', action: 'deny', targets: [`${BAD_PKG}::*`] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${BAD_PKG}::exploit::drain` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/denied by policy: block-bad/)
  })

  test('deny with any-match: blocks if ANY call matches denied target', async () => {
    const policies = loadPolicies([
      { name: 'block-bad', action: 'deny', targets: [`${BAD_PKG}::*`] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
      tx.moveCall({ target: `${BAD_PKG}::exploit::drain` })
    })
    expect(() => validate(txBytes, policies)).toThrow(/denied by policy: block-bad/)
  })

  test('deny rejects allow-only fields', () => {
    expect(() => loadPolicies([
      { name: 'bad-deny', action: 'deny', targets: ['*'], maxCommands: 5 },
    ])).toThrow(/Deny policies only support targets and senders/)
  })

  test('deny rejects suinsNames', () => {
    expect(() => loadPolicies([
      { name: 'bad-deny', action: 'deny', suinsNames: ['*.evil.sui'] },
    ])).toThrow(/Deny policies only support targets and senders/)
  })
})

// ─── SuiNS name policies ─────────────────────────────────────────────────────

describe('suinsNames policies', () => {
  test('wildcard *.onara.sui matches alice.onara.sui', async () => {
    const policies = loadPolicies([
      { name: 'onara-community', suinsNames: ['*.onara.sui'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    const result = validate(txBytes, policies, { senderName: 'alice.onara.sui' })
    expect(result.matchedPolicyName).toBe('onara-community')
  })

  test('wildcard *.onara.sui does NOT match onara.sui (DNS RFC 4592)', async () => {
    const policies = loadPolicies([
      { name: 'onara-community', suinsNames: ['*.onara.sui'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() =>
      validate(txBytes, policies, { senderName: 'onara.sui' }),
    ).toThrow(/did not match any sponsor policy/)
  })

  test('exact match onara.sui', async () => {
    const policies = loadPolicies([
      { name: 'onara-exact', suinsNames: ['onara.sui'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    const result = validate(txBytes, policies, { senderName: 'onara.sui' })
    expect(result.matchedPolicyName).toBe('onara-exact')
  })

  test('combined wildcard + exact matches both', async () => {
    const policies = loadPolicies([
      { name: 'onara-all', suinsNames: ['*.onara.sui', 'onara.sui'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(validate(txBytes, policies, { senderName: 'alice.onara.sui' }).matchedPolicyName).toBe('onara-all')
    expect(validate(txBytes, policies, { senderName: 'onara.sui' }).matchedPolicyName).toBe('onara-all')
  })

  test('no SuiNS name soft-skips to next policy', async () => {
    const policies = loadPolicies([
      { name: 'onara-community', suinsNames: ['*.onara.sui'], targets: ['*'] },
      { name: 'allow-all', targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    const result = validate(txBytes, policies, { senderName: null })
    expect(result.matchedPolicyName).toBe('allow-all')
  })

  test('no SuiNS name with no fallback policy rejects', async () => {
    const policies = loadPolicies([
      { name: 'onara-only', suinsNames: ['*.onara.sui'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    expect(() =>
      validate(txBytes, policies, { senderName: null }),
    ).toThrow(/did not match any sponsor policy/)
  })

  test('case insensitive matching', async () => {
    const policies = loadPolicies([
      { name: 'onara-community', suinsNames: ['*.Sona.SUI'], targets: ['*'] },
    ])
    const txBytes = await buildTxBytes((tx) => {
      tx.moveCall({ target: `${PKG}::mod::fn` })
    })
    const result = validate(txBytes, policies, { senderName: 'Alice.SONA.sui' })
    expect(result.matchedPolicyName).toBe('onara-community')
  })

  test('needsSuinsResolution is true when a policy uses suinsNames', () => {
    const policies = loadPolicies([
      { name: 'onara', suinsNames: ['*.onara.sui'], targets: ['*'] },
    ])
    expect(policies.needsSuinsResolution).toBe(true)
  })

  test('needsSuinsResolution is false when no policy uses suinsNames', () => {
    const policies = loadPolicies([
      { name: 'allow-all', targets: ['*'] },
    ])
    expect(policies.needsSuinsResolution).toBe(false)
  })
})
