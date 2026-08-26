import type { ClientWithCoreApi, SuiClientTypes } from '@mysten/sui/client'
import { normalizeSuiAddress, normalizeSuiObjectId } from '@mysten/sui/utils'

const OBJECTS_PER_REQUEST = 50

export class OwnedInputAuthorizationError extends Error {}
export class OwnedInputLookupError extends Error {}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function senderControlsOwner(
  owner: SuiClientTypes.ObjectOwner | undefined,
  sender: string,
): boolean {
  if (!owner) return false
  if (owner.$kind === 'Immutable') return true
  if (owner.$kind === 'AddressOwner') {
    return normalizeSuiAddress(owner.AddressOwner) === sender
  }
  if (owner.$kind === 'ConsensusAddressOwner') {
    return normalizeSuiAddress(owner.ConsensusAddressOwner.owner) === sender
  }
  return false
}

/**
 * A sponsor signature must authorize gas only. Prove that every address-owned
 * command input is controlled by the sender before the sponsor co-signs.
 */
export async function assertSenderControlsOwnedInputs({
  client,
  sender,
  objectIds,
}: {
  client: ClientWithCoreApi
  sender: string
  objectIds: readonly string[]
}): Promise<void> {
  if (objectIds.length === 0) return

  const normalizedSender = normalizeSuiAddress(sender)
  const normalizedIds = [
    ...new Set(objectIds.map((objectId) => normalizeSuiObjectId(objectId))),
  ]
  let objects: (SuiClientTypes.Object | Error)[]
  try {
    const responses = await Promise.all(
      chunks(normalizedIds, OBJECTS_PER_REQUEST).map((objectIds) =>
        client.core.getObjects({ objectIds }),
      ),
    )
    objects = responses.flatMap((response) => response.objects)
  } catch (cause) {
    throw new OwnedInputLookupError(
      'Unable to verify sponsored transaction object ownership.',
      { cause },
    )
  }

  const expectedIds = new Set(normalizedIds)
  const objectsById = new Map<string, SuiClientTypes.Object>()
  for (const object of objects) {
    if (object instanceof Error) {
      throw new OwnedInputLookupError(
        'Unable to verify sponsored transaction object ownership.',
        { cause: object },
      )
    }
    const objectId = normalizeSuiObjectId(object.objectId)
    if (!expectedIds.has(objectId) || objectsById.has(objectId)) {
      throw new OwnedInputLookupError(
        'RPC returned an unexpected sponsored transaction object input.',
      )
    }
    objectsById.set(objectId, object)
  }

  for (const objectId of normalizedIds) {
    const object = objectsById.get(objectId)
    if (!object) {
      throw new OwnedInputLookupError(
        'Unable to verify every sponsored transaction object input.',
      )
    }
    if (!senderControlsOwner(object.owner, normalizedSender)) {
      throw new OwnedInputAuthorizationError(
        `Sponsored transaction input is not controlled by the sender: ${objectId}`,
      )
    }
  }
}
