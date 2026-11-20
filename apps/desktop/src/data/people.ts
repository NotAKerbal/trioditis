import { api } from '@trioditis/backend/api'
import {
  CONTACT_LIST_NETWORKS,
  contactKey,
  planImport,
  type ContactIdentifiersPlaintext,
  type ContactPlaintext,
  type NetworkContact,
  type Person,
  type PersonPlaintext,
} from '@trioditis/core'
import { sealJson, type Envelope } from '@trioditis/crypto'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useEffect, useMemo, useRef } from 'react'
import { useAccounts } from '~/data/chats.ts'
import { errorCode } from '~/lib/errors.ts'
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
/** How many times a change is worked out again after another device changed the address book. */
const RETRIES = 4

/** A card as stored: with when it last changed, so an edit can tell it changed elsewhere since. */
export type StoredPerson = Person & { updatedAt: number }

/** A change to the address book, worked out from the latest cards: the cards it adds or replaces. */
export type Change = (people: readonly StoredPerson[]) => Person[]

/** Thrown by a change that no longer applies, such as an edit to a card changed elsewhere. */
export class Stale extends Error {}

const cardCache = new Map<string, PersonPlaintext | null>()
const contactCache = new Map<string, ContactPlaintext | null>()
const identifierCache = new Map<string, ContactIdentifiersPlaintext | null>()

/** Keeps loading pages until there are none left: the address book is matched as a whole. */
function useEveryPage(status: string, loadMore: (n: number) => void, pageSize: number) {
  useEffect(() => {
    if (status === 'CanLoadMore') loadMore(pageSize)
  }, [status, loadMore, pageSize])
}

/** Every card, opened, or undefined until they've all loaded. Ones this device can't open are left out. */
export function usePeople(): StoredPerson[] | undefined {
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
      return card ? [{ personKey: row.personKey, card, updatedAt: row.updatedAt }] : []
    })
  }, [results, status, session])
}

/** Every contact on every network, opened with what the person's logins know them by, or undefined until loaded. */
export function useNetworkContacts(): NetworkContact[] | undefined {
  const session = useSession()
  const { results, status, loadMore } = usePaginatedQuery(api.contacts.list, {}, { initialNumItems: 500 })
  useEveryPage(status, loadMore, 500)
  return useMemo(() => {
    if (status !== 'Exhausted') return undefined
    const open = <T>(cache: Map<string, T | null>, sealed: Envelope | undefined, objectId: string) =>
      openCached<T>(cache, sealed, session.keyPair, session.kid, 'contact', session.userId, objectId)
    return results.flatMap((r) => {
      const profile = open<ContactPlaintext>(contactCache, r.sealedProfile, r.ghostId)
      if (!profile) return []
      // Each of the person's logins on the network has its own; together they're all the
      // person knows this contact by.
      const identifiers = [
        ...new Set(
          (r.identifiers ?? []).flatMap(
            ({ loginId, sealed }) =>
              open<ContactIdentifiersPlaintext>(identifierCache, sealed, `${r.ghostId}/identifiers/${loginId}`)
                ?.identifiers ?? [],
          ),
        ),
      ]
      return [{ network: r.network, ghostId: r.ghostId, profile, ...(identifiers.length ? { identifiers } : {}) }]
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

/**
 * Resolves once `ready` holds, or after `ms` regardless. It checks on a timer, not each frame,
 * so it carries on in a window that's hidden.
 */
function until(ready: () => boolean, ms: number) {
  const start = Date.now()
  return new Promise<void>((resolve) => {
    const check = () => (ready() || Date.now() - start > ms ? resolve() : setTimeout(check, 50))
    check()
  })
}

/**
 * Saving and deleting cards, sealed to the person before they leave this device. Every write
 * names the address book revision it was worked out from; when another device has changed it
 * since, the change is worked out again from the new cards, so a contact never ends up on two.
 */
export function usePeopleActions(people: StoredPerson[] | undefined) {
  const session = useSession()
  const put = useMutation(api.people.put)
  const remove = useMutation(api.people.remove)
  const { data: revision } = useQuery(convexQuery(api.people.revision, {}))
  const latest = useRef({ people, revision })
  latest.current = { people, revision }

  const seal = ({ personKey, card }: Person) => ({
    personKey,
    sealed: sealJson(fitCard(card), [{ publicKey: session.keyPair.publicKey }], {
      kind: 'person',
      ownerUserId: session.userId,
      objectId: personKey,
    }),
  })

  /**
   * Runs a write against the latest address book, and again from a newer one if it was refused
   * as stale. `write` gets the cards and revision, and returns how many of its calls went
   * through before one failed, so a long import carries on where it stopped.
   */
  async function withRevision(write: (people: readonly StoredPerson[], revision: number) => Promise<void>) {
    for (let attempt = 0; ; attempt++) {
      await until(() => latest.current.people !== undefined && latest.current.revision !== undefined, 10_000)
      const { people, revision } = latest.current
      if (!people || revision === undefined) throw new Error('Your people haven’t loaded yet.')
      try {
        return await write(people, revision)
      } catch (err) {
        if (errorCode(err) !== 'people_changed' || attempt >= RETRIES) throw err
        // The new revision and its cards arrive together; wait for them before working it out again.
        await until(() => latest.current.revision !== revision && latest.current.people !== undefined, 5_000)
      }
    }
  }

  /** Applies a change, worked out again from the latest cards whenever another device got there first. */
  async function apply(change: Change) {
    await withRevision(async (people, revision) => {
      const changed = change(people)
      if (changed.length > PER_CALL) throw new Error('Change at most 100 people at once.')
      if (changed.length) await put({ people: changed.map(seal), revision, sessionId: session.sessionId })
    })
  }

  /**
   * Saves many cards in calls of 100, as an import does. When a call is refused as stale, the
   * whole change is worked out again from the new cards, which have the calls before it: so
   * `cards` must leave out what's already done (an import plan does) and work out links again.
   * Returns how many cards were written.
   */
  async function saveMany(cards: (people: readonly StoredPerson[]) => Person[], onProgress?: (done: number) => void) {
    const written = new Set<string>()
    await withRevision(async (people, revision) => {
      const planned = cards(people)
      let at = revision
      for (let i = 0; i < planned.length; i += PER_CALL) {
        const batch = planned.slice(i, i + PER_CALL)
        at = await put({ people: batch.map(seal), revision: at, sessionId: session.sessionId })
        for (const p of batch) written.add(p.personKey)
        onProgress?.(written.size)
      }
    })
    return written.size
  }

  async function removeAll(personKeys: readonly string[]) {
    let done = 0
    await withRevision(async (_people, revision) => {
      let at = revision
      while (done < personKeys.length) {
        const batch = personKeys.slice(done, done + PER_CALL)
        at = await remove({ personKeys: batch, revision: at })
        done += batch.length
      }
    })
  }

  return { apply, saveMany, remove: removeAll }
}

/**
 * The cards an import makes or changes (packages/core, planImport). Each entry's new key is
 * picked once, so the plan comes out the same however often it's worked out again.
 */
export function importPlanner(imported: readonly PersonPlaintext[]) {
  const keys = imported.map(() => newClientId())
  return (existing: readonly Person[]) => planImport(existing, imported, (index) => keys[index]!)
}

/**
 * Asks each of the person's connected accounts on a network that can list contacts for them.
 * Returns how many were asked; an account asked in the last ten minutes isn't asked again.
 */
export function useSyncContacts() {
  const accounts = useAccounts()
  const sync = useMutation(api.contacts.sync)
  const syncable = (accounts ?? []).filter((a) => a.state === 'CONNECTED' && CONTACT_LIST_NETWORKS.includes(a.network))
  return {
    available: syncable.length > 0,
    run: async () => {
      let asked = 0
      for (const account of syncable) if ((await sync({ networkAccountId: account._id })).queued) asked++
      return asked
    },
  }
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
