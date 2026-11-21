import { api } from '@trioditis/backend/api'
import {
  cardTitle,
  CONTACT_LIST_NETWORKS,
  contactKey,
  MAX_IMPORT_CARDS,
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
/** Smaller sizes a picture is made, in turn, when a card is still too large with it. */
const SMALLER_PHOTOS = [96, 64, 48, 32]
/** How many times a change is worked out again after another device changed the address book. */
const RETRIES = 4

/** A card as stored: with when it last changed, so an edit can tell it changed elsewhere since. */
export type StoredPerson = Person & { updatedAt: number }

/** A change to the address book, worked out from the latest cards: the cards it adds or replaces. */
export type Change = (people: readonly StoredPerson[]) => Person[]

/** Thrown by a change that no longer applies, such as an edit to a card changed elsewhere. */
export class Stale extends Error {}

/** Thrown, before anything is saved, by a change with a card that can't be made to fit. */
export class TooLarge extends Error {}

/**
 * Thrown by saveMany when a call fails after others went through: the cards those wrote stay
 * written (each call is its own transaction), so the person is told how far it got.
 */
export class PartlySaved extends Error {
  readonly written: number
  readonly total: number
  readonly reason: unknown
  constructor(written: number, total: number, reason: unknown) {
    super('Only some were saved.')
    this.written = written
    this.total = total
    this.reason = reason
  }
}

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
  const contacts = usePaginatedQuery(api.contacts.list, {}, { initialNumItems: 500 })
  useEveryPage(contacts.status, contacts.loadMore, 500)
  const identifiers = usePaginatedQuery(api.contacts.identifiers, {}, { initialNumItems: 500 })
  useEveryPage(identifiers.status, identifiers.loadMore, 500)
  return useMemo(() => {
    if (contacts.status !== 'Exhausted' || identifiers.status !== 'Exhausted') return undefined
    const open = <T>(cache: Map<string, T | null>, sealed: Envelope, objectId: string) =>
      openCached<T>(cache, sealed, session.keyPair, session.kid, 'contact', session.userId, objectId)
    // Each of the person's logins has its own; together they're all the person knows a contact by.
    const known = new Map<string, Set<string>>()
    for (const r of identifiers.results) {
      const plain = open<ContactIdentifiersPlaintext>(
        identifierCache,
        r.sealed,
        `${r.ghostId}/identifiers/${r.loginId}`,
      )
      const key = contactKey(r)
      for (const id of plain?.identifiers ?? []) known.set(key, (known.get(key) ?? new Set()).add(id))
    }
    return contacts.results.flatMap((r) => {
      const profile = open<ContactPlaintext>(contactCache, r.sealedProfile, r.ghostId)
      if (!profile) return []
      const ids = known.get(contactKey(r))
      return [
        {
          network: r.network,
          ghostId: r.ghostId,
          profile,
          ...(r.networkAccountIds ? { networkAccountIds: r.networkAccountIds } : {}),
          ...(ids?.size ? { identifiers: [...ids] } : {}),
        },
      ]
    })
  }, [contacts.results, contacts.status, identifiers.results, identifiers.status, session])
}

/** Contacts by `contactKey`, for showing a card's links. */
export function contactsByKey(contacts: readonly NetworkContact[] | undefined) {
  return new Map((contacts ?? []).map((c) => [contactKey(c), c]))
}

const cardBytes = (card: PersonPlaintext) => new TextEncoder().encode(JSON.stringify(card)).length
const fits = (card: PersonPlaintext) => cardBytes(card) <= MAX_CARD_BYTES

/** What fitCard did to a card to make it fit, so the person can be told. */
export interface Fitted {
  card: PersonPlaintext
  /** The photo was made smaller, or left out because the card was too large even with a tiny one. */
  photo?: 'smaller' | 'dropped'
  /** How many characters were cut off the end of the note, as a last resort. */
  noteCut?: number
  /** Whether the card fits now; it doesn't when nothing more may be taken off. */
  fits: boolean
}

/**
 * A card made to fit what a card can be sealed to. Its photo is made smaller, step by step.
 * Leaving the photo out, then cutting the note, happen only when allowed (`dropPhoto`,
 * `cutNote`): an import, which reports them. An edit allows neither, and is refused instead,
 * so a saved card never loses its photo or note without the person doing it.
 */
export async function fitCard(
  card: PersonPlaintext,
  shrink: (photo: string, pixels: number) => Promise<string | null>,
  { cutNote = false, dropPhoto = false } = {},
): Promise<Fitted> {
  let out = card
  if (fits(out)) return { card: out, fits: true }
  let photo: Fitted['photo']
  if (out.photo) {
    const original = out.photo
    for (const pixels of SMALLER_PHOTOS) {
      const smaller = await shrink(original, pixels)
      if (!smaller) break
      out = { ...out, photo: smaller }
      photo = 'smaller'
      if (fits(out)) return { card: out, photo, fits: true }
    }
    if (!dropPhoto) return { card, fits: false }
    out = { ...out }
    delete out.photo
    photo = 'dropped'
    if (fits(out)) return { card: out, photo, fits: true }
  }
  if (!cutNote || !out.note) return { card: out, photo, fits: false }
  const note = out.note
  // Cut by what's over in bytes, then by a little more until it fits: escaping in JSON makes
  // some characters take more than one.
  let keep = Math.max(0, note.length - (cardBytes(out) - MAX_CARD_BYTES))
  while (keep > 0 && !fits({ ...out, note: note.slice(0, keep) })) keep = Math.max(0, keep - 256)
  out = { ...out, note: note.slice(0, keep) }
  if (!keep) delete out.note
  return { card: out, photo, noteCut: note.length - keep, fits: fits(out) }
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
    sealed: sealJson(card, [{ publicKey: session.keyPair.publicKey }], {
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

  /**
   * Cards made to fit before any is written: a photo made smaller, never a note cut. One that
   * still doesn't fit stops the whole change, so nothing is half done or quietly shortened.
   */
  async function fitted(changed: readonly Person[]) {
    const out: Person[] = []
    for (const p of changed) {
      const fit = await fitCard(p.card, shrinkPhoto)
      if (!fit.fits) {
        throw new TooLarge(
          `${cardTitle(p.card)} is too large to save${p.card.photo ? ', even with a smaller photo' : ''}. ` +
            'Shorten the note or remove some details, then try again.',
        )
      }
      out.push({ personKey: p.personKey, card: fit.card })
    }
    return out
  }

  /** Applies a change, worked out again from the latest cards whenever another device got there first. */
  async function apply(change: Change) {
    await withRevision(async (people, revision) => {
      const changed = await fitted(change(people))
      if (changed.length > PER_CALL) throw new Error('Change at most 100 people at once.')
      if (changed.length) await put({ people: changed.map(seal), revision, sessionId: session.sessionId })
    })
  }

  /**
   * Saves many cards in calls of 100, as an import does. When a call is refused as stale, the
   * rest of the change is worked out again from the new cards, so their links are current; the
   * cards already written are left out, so a change made to one since (or its deletion) stands.
   * Everything that can be checked here is checked before the first call: every card fits, and
   * the new ones fit in the address book. A call failing after others went through throws
   * PartlySaved, saying how many were written. Returns how many cards were written.
   */
  async function saveMany(
    cards: (people: readonly StoredPerson[]) => Person[],
    onWritten?: (personKeys: readonly string[]) => void,
  ) {
    const written = new Set<string>()
    let total = 0
    try {
      await withRevision(async (people, revision) => {
        const planned = await fitted(cards(people).filter((p) => !written.has(p.personKey)))
        total = written.size + planned.length
        const added = newCards(people, planned)
        if (people.length + added > MAX_IMPORT_CARDS) throw new TooLarge(tooMany(people.length, added))
        let at = revision
        for (let i = 0; i < planned.length; i += PER_CALL) {
          const batch = planned.slice(i, i + PER_CALL)
          at = await put({ people: batch.map(seal), revision: at, sessionId: session.sessionId })
          for (const p of batch) written.add(p.personKey)
          onWritten?.(batch.map((p) => p.personKey))
        }
      })
    } catch (err) {
      if (written.size) throw new PartlySaved(written.size, total, err)
      throw err
    }
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
 * The cards an import makes or changes (packages/core, planImport), for saveMany. Each entry's
 * new key is picked once, so the plan comes out the same however often it's worked out again,
 * and an entry once written is left out of later plans, so a card it made or changed that's
 * edited or deleted elsewhere meanwhile stays as that left it.
 */
export function importPlanner(imported: readonly PersonPlaintext[]) {
  const keys = imported.map(() => newClientId())
  const own = new Set(keys)
  const done = new Set<number>()
  const entriesOf = new Map<string, number[]>()
  // The entries the latest plan left out because each could be more than one card.
  let ambiguous = new Set<number>()
  return {
    plan: (existing: readonly Person[]) => {
      ambiguous = new Set()
      const pending = imported.flatMap((card, index) => (done.has(index) ? [] : [{ card, index }]))
      const planned = planImport(
        existing,
        pending.map((p) => p.card),
        (i) => keys[pending[i]!.index]!,
        (i, personKey) => entriesOf.set(personKey, [...(entriesOf.get(personKey) ?? []), pending[i]!.index]),
        // A card this import made, seen in a later plan, isn't someone else to match.
        (personKey) => !own.has(personKey),
        (i) => ambiguous.add(pending[i]!.index),
      )
      return planned
    },
    /** The cards left out because each matched several people here, for the import's summary. */
    ambiguous: () => [...ambiguous].map((index) => imported[index]!),
    written: (personKeys: Iterable<string>) => {
      for (const key of personKeys) for (const index of entriesOf.get(key) ?? []) done.add(index)
    },
  }
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

/** How many of `planned` aren't cards yet: the ones that count against the address book's limit. */
export function newCards(people: readonly Person[], planned: readonly Person[]) {
  const here = new Set(people.map((p) => p.personKey))
  return planned.filter((p) => !here.has(p.personKey)).length
}

/** Why an import that would go past the address book's limit was refused, with the numbers. */
export function tooMany(have: number, adding: number) {
  const room = Math.max(0, MAX_IMPORT_CARDS - have)
  return (
    `That would add ${adding.toLocaleString()} people, and there’s room for ${room.toLocaleString()} ` +
    `more (People holds ${MAX_IMPORT_CARDS.toLocaleString()}).`
  )
}

/** A picture made small, as a JPEG data URL; null if it can't be read as an image. */
export async function shrinkPhoto(dataUrl: string, pixels = PHOTO_PIXELS): Promise<string | null> {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, pixels / Math.max(bitmap.width, bitmap.height))
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
