import { api } from '@trioditis/backend/api'
import {
  contactKey,
  mergeCards,
  type ContactPlaintext,
  type NetworkContact,
  type Person,
  type PersonPlaintext,
} from '@trioditis/core'
import { sealJson } from '@trioditis/crypto'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useEffect, useMemo } from 'react'
import { newClientId, openCached } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

// The address book on this device: every card and every network contact, opened here, since
// matching them needs what's sealed. See client-api.md, People.

/** What people.put and people.remove take per call. */
const PER_CALL = 100
/** A card seals to at most this (people.ts, MAX_PERSON_BYTES), less room for the envelope. */
const MAX_CARD_BYTES = 60 * 1024
/** Imported pictures are made this small, as wide and high, to keep cards small. */
const PHOTO_PIXELS = 128

const cardCache = new Map<string, PersonPlaintext | null>()
const contactCache = new Map<string, ContactPlaintext | null>()

/** Keeps loading pages until there are none left: the address book is matched as a whole. */
function useEveryPage(status: string, loadMore: (n: number) => void, pageSize: number) {
  useEffect(() => {
    if (status === 'CanLoadMore') loadMore(pageSize)
  }, [status, loadMore, pageSize])
}

/** Every card, opened, or undefined until they've all loaded. Ones this device can't open are left out. */
export function usePeople(): Person[] | undefined {
  const session = useSession()
  const { results, status, loadMore } = usePaginatedQuery(api.people.list, {}, { initialNumItems: 100 })
  useEveryPage(status, loadMore, 100)
  return useMemo(() => {
    if (status !== 'Exhausted') return undefined
    return results.flatMap((row) => {
      const card = openCached<PersonPlaintext>(
        cardCache,
        row.sealed,
        session.keyPair,
        session.kid,
        'person',
        session.userId,
        row.personKey,
      )
      return card ? [{ personKey: row.personKey, card }] : []
    })
  }, [results, status, session])
}

/** Every contact on every network, opened, or undefined until they've all loaded. */
export function useNetworkContacts(): NetworkContact[] | undefined {
  const session = useSession()
  const { results, status, loadMore } = usePaginatedQuery(api.contacts.list, {}, { initialNumItems: 500 })
  useEveryPage(status, loadMore, 500)
  return useMemo(() => {
    if (status !== 'Exhausted') return undefined
    return results.flatMap((row) => {
      const profile = openCached<ContactPlaintext>(
        contactCache,
        row.sealedProfile,
        session.keyPair,
        session.kid,
        'contact',
        session.userId,
        row.ghostId,
      )
      return profile ? [{ network: row.network, ghostId: row.ghostId, profile }] : []
    })
  }, [results, status, session])
}

/** Contacts by `contactKey`, for showing a card's links. */
export function contactsByKey(contacts: readonly NetworkContact[] | undefined) {
  return new Map((contacts ?? []).map((c) => [contactKey(c), c]))
}

const cardBytes = (card: PersonPlaintext) => new TextEncoder().encode(JSON.stringify(card)).length

/** A card that fits: its photo goes first, then its note is cut. */
export function fitCard(card: PersonPlaintext): PersonPlaintext {
  let out = card
  if (cardBytes(out) > MAX_CARD_BYTES && out.photo) out = { ...out, photo: undefined }
  if (cardBytes(out) > MAX_CARD_BYTES && out.note) {
    const over = cardBytes(out) - MAX_CARD_BYTES
    out = { ...out, note: out.note.slice(0, Math.max(0, out.note.length - over - 16)) }
  }
  return JSON.parse(JSON.stringify(out)) as PersonPlaintext
}

/** Saving and deleting cards, sealed to the person before they leave this device. */
export function usePeopleActions() {
  const session = useSession()
  const put = useMutation(api.people.put)
  const remove = useMutation(api.people.remove)

  async function save(people: readonly Person[], onProgress?: (done: number) => void) {
    for (let i = 0; i < people.length; i += PER_CALL) {
      const batch = people.slice(i, i + PER_CALL).map(({ personKey, card }) => ({
        personKey,
        sealed: sealJson(fitCard(card), [{ publicKey: session.keyPair.publicKey }], {
          kind: 'person',
          ownerUserId: session.userId,
          objectId: personKey,
        }),
      }))
      // Sealed to this page's account: refused if the browser has moved to another since.
      await put({ people: batch, sessionId: session.sessionId })
      onProgress?.(Math.min(i + PER_CALL, people.length))
    }
  }

  async function removeAll(personKeys: readonly string[]) {
    for (let i = 0; i < personKeys.length; i += PER_CALL)
      await remove({ personKeys: personKeys.slice(i, i + PER_CALL) })
  }

  return { save, remove: removeAll }
}

/**
 * The cards an import makes or changes. A card whose UID matches one already here updates it
 * (the file's fields win, the links stay); the rest are new.
 */
export function importPlan(existing: readonly Person[], imported: readonly PersonPlaintext[]): Person[] {
  const byUid = new Map(existing.filter((p) => p.card.uid).map((p) => [p.card.uid!, p]))
  return imported.map((card) => {
    const same = card.uid ? byUid.get(card.uid) : undefined
    return same
      ? { personKey: same.personKey, card: { ...mergeCards(card, same.card), name: card.name || same.card.name } }
      : { personKey: newClientId(), card }
  })
}

/** A picture made small, as a JPEG data URL; null if it can't be read as an image. */
export async function shrinkPhoto(dataUrl: string): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, PHOTO_PIXELS / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.8)
  } catch {
    return null
  }
}

/** Saves text as a file the person downloads. */
export function download(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
