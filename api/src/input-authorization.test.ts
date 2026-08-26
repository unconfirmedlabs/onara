import { describe, expect, test } from 'bun:test'
import type { ClientWithCoreApi } from '@mysten/sui/client'
import { normalizeSuiObjectId } from '@mysten/sui/utils'
import {
  assertSenderControlsOwnedInputs,
  OwnedInputAuthorizationError,
  OwnedInputLookupError,
} from './input-authorization'

const SENDER =
  '0x0000000000000000000000000000000000000000000000000000000000000001'
const SPONSOR =
  '0x0000000000000000000000000000000000000000000000000000000000000002'

function clientWithOwners(
  owners: Map<string, unknown>,
  calls: string[][] = [],
): ClientWithCoreApi {
  return {
    core: {
      getObjects: async ({ objectIds }: { objectIds: string[] }) => {
        calls.push(objectIds)
        return {
          objects: objectIds.map((objectId) => ({
            objectId,
            owner: owners.get(objectId),
          })),
        }
      },
    },
  } as unknown as ClientWithCoreApi
}

describe('sender-owned input authorization', () => {
  test('accepts sender-owned and immutable inputs', async () => {
    const ids = ['0x11', '0x12']
    const owners = new Map([
      [
        normalizeSuiObjectId('0x11'),
        { $kind: 'AddressOwner', AddressOwner: SENDER },
      ],
      [
        normalizeSuiObjectId('0x12'),
        { $kind: 'Immutable', Immutable: true },
      ],
    ])

    await expect(
      assertSenderControlsOwnedInputs({
        client: clientWithOwners(owners),
        sender: SENDER,
        objectIds: ids,
      }),
    ).resolves.toBeUndefined()
  })

  test('rejects a sponsor-owned command input', async () => {
    const objectId = normalizeSuiObjectId('0x11')
    const owners = new Map([
      [objectId, { $kind: 'AddressOwner', AddressOwner: SPONSOR }],
    ])

    await expect(
      assertSenderControlsOwnedInputs({
        client: clientWithOwners(owners),
        sender: SENDER,
        objectIds: [objectId],
      }),
    ).rejects.toBeInstanceOf(OwnedInputAuthorizationError)
  })

  test('fails unavailable when an input cannot be loaded', async () => {
    const client = {
      core: {
        getObjects: async () => ({ objects: [new Error('RPC unavailable')] }),
      },
    } as unknown as ClientWithCoreApi

    await expect(
      assertSenderControlsOwnedInputs({
        client,
        sender: SENDER,
        objectIds: ['0x11'],
      }),
    ).rejects.toBeInstanceOf(OwnedInputLookupError)
  })

  test('fails closed when the RPC omits an input', async () => {
    const client = {
      core: {
        getObjects: async () => ({ objects: [] }),
      },
    } as unknown as ClientWithCoreApi

    await expect(
      assertSenderControlsOwnedInputs({
        client,
        sender: SENDER,
        objectIds: ['0x11'],
      }),
    ).rejects.toBeInstanceOf(OwnedInputLookupError)
  })

  test('fails closed when the RPC substitutes another object', async () => {
    const client = {
      core: {
        getObjects: async () => ({
          objects: [
            {
              objectId: normalizeSuiObjectId('0x12'),
              owner: { $kind: 'AddressOwner', AddressOwner: SENDER },
            },
          ],
        }),
      },
    } as unknown as ClientWithCoreApi

    await expect(
      assertSenderControlsOwnedInputs({
        client,
        sender: SENDER,
        objectIds: ['0x11'],
      }),
    ).rejects.toBeInstanceOf(OwnedInputLookupError)
  })

  test('chunks large ownership checks', async () => {
    const objectIds = Array.from({ length: 51 }, (_, index) =>
      `0x${(index + 1).toString(16)}`,
    )
    const owners = new Map(
      objectIds.map((objectId) => [
        normalizeSuiObjectId(objectId),
        { $kind: 'AddressOwner', AddressOwner: SENDER },
      ]),
    )
    const calls: string[][] = []

    await assertSenderControlsOwnedInputs({
      client: clientWithOwners(owners, calls),
      sender: SENDER,
      objectIds,
    })
    expect(calls.map((call) => call.length)).toEqual([50, 1])
  })
})
