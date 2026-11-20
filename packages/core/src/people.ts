// The address book: cards for the people someone knows, and how a card links that person's
// contacts on each network. Cards are sealed to their owner (kind `person`), so matching a card
// to a network contact happens on the person's device, never on the server. See
// docs/architecture/client-api.md, People.

import type { ContactPlaintext, Network } from './index.ts'

/** One phone number, email, username or website on a card, with the label it was saved under. */
export interface PersonField {
  value: string
  /** `mobile`, `home`, `work`, or the person's own label. */
  label?: string
}

export interface PersonAddress {
  label?: string
  street?: string
  locality?: string
  region?: string
  postcode?: string
  country?: string
}

/** A network contact the card is about: `ghostId` is unique on its network. */
export interface PersonLink {
  network: Network
  ghostId: string
}

/**
 * A card's sealed plaintext. Its fields follow vCard (RFC 6350), which is what phones and
 * address books export, so an imported card keeps what it had and exports again unchanged.
 */
export interface PersonPlaintext {
  /** What the card is shown as: vCard's FN. */
  name: string
  given?: string
  family?: string
  middle?: string
  prefix?: string
  suffix?: string
  nickname?: string
  org?: string
  title?: string
  phones?: PersonField[]
  emails?: PersonField[]
  /**
   * Usernames, as a URI where the service is known (`telegram:alice`, `signal:alice.01`,
   * `instagram:alice`), the way the networks report them, so they match.
   */
  handles?: PersonField[]
  urls?: PersonField[]
  addresses?: PersonAddress[]
  /** `YYYY-MM-DD`, or `--MM-DD` when the year isn't known. */
  birthday?: string
  note?: string
  /** A small picture, as a `data:image/…;base64,` URL. */
  photo?: string
  /** The network contacts this card is about. A contact is on one card at most. */
  links?: PersonLink[]
  /** The card's UID where it came from, so importing the same file again updates it. */
  uid?: string
  [extra: string]: unknown
}

/** A card as the client holds it: opened, with the key it's stored under. */
export interface Person {
  personKey: string
  card: PersonPlaintext
}

/** A network contact as the client holds it: opened. */
export interface NetworkContact {
  network: Network
  ghostId: string
  profile: ContactPlaintext
}

export const contactKey = (c: { network: Network; ghostId: string }) => `${c.network}/${c.ghostId}`

// Identifiers. Networks report a contact's as URIs (`tel:+15551234567`, `mailto:a@b.c`,
// `telegram:alice`); cards hold what people typed or their phone exported. Both become keys
// that compare equal when they name the same number, address or username.

const SCHEME = /^([a-z][a-z0-9+.-]*):(.+)$/i
/** Fewer digits than this is a short code or an extension, too likely to match a stranger. */
const MIN_PHONE_DIGITS = 7

/** The digits of a phone number, with whether they include the country code. */
export function phoneDigits(raw: string): { digits: string; international: boolean } | null {
  const text = raw
    .trim()
    .replace(/^tel:/i, '')
    .split(/[;,]|\s*(?:x|ext\.?)\s*\d/i)[0]!
  if (/[a-z]/i.test(text.replace(/^tel:/i, ''))) return null
  let digits = text.replace(/\D/g, '')
  let international = text.trimStart().startsWith('+')
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2)
    international = true
  }
  // A national number's trunk prefix (the 0 in 020 or 07700) isn't part of it internationally.
  if (!international) digits = digits.replace(/^0+/, '')
  return digits.length >= MIN_PHONE_DIGITS ? { digits, international } : null
}

/**
 * Whether two numbers are the same. Two with their country code must be equal; otherwise the
 * shorter must end the longer (a number saved without its country code matches one with it).
 */
export function samePhone(a: string, b: string): boolean {
  const x = phoneDigits(a)
  const y = phoneDigits(b)
  if (!x || !y) return false
  if (x.international && y.international) return x.digits === y.digits
  const n = Math.min(x.digits.length, y.digits.length)
  return x.digits.slice(-n) === y.digits.slice(-n)
}

const normalEmail = (raw: string) =>
  raw
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase()
const looksLikeEmail = (raw: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalEmail(raw))
const looksLikePhone = (raw: string) => /^\+?[\d\s().\-–]{7,}$/.test(raw.trim()) && phoneDigits(raw) !== null

/** A username without the `@` people type before it, lowercased: usernames ignore case. */
const normalUser = (raw: string) => raw.trim().replace(/^@/, '').toLowerCase()

// Profile links people save on cards, and the network username each one is.
const PROFILE_URLS: [RegExp, string][] = [
  [/^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})\/?$/i, 'twitter'],
  [/^(?:https?:\/\/)?(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{1,30})\/?$/i, 'instagram'],
  [/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i, 'telegram'],
  [/^(?:https?:\/\/)?bsky\.app\/profile\/([^/\s]+)\/?$/i, 'bluesky'],
]

/** The `service:username` a profile link stands for, or null. */
export function handleFromUrl(url: string): string | null {
  for (const [pattern, service] of PROFILE_URLS) {
    const m = pattern.exec(url.trim())
    if (m) return `${service}:${normalUser(m[1]!)}`
  }
  return null
}

/** What one identifier is: a phone number, an email address, or a username on a service. */
export type Identifier =
  | { kind: 'phone'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'username'; service: string; value: string }

/**
 * Reads an identifier as a network reports it, or as a card holds it. A bare value is a phone
 * number or email if it looks like one, and otherwise a username on `defaultService` (the
 * network a contact's handle came from), if given.
 */
export function parseIdentifier(raw: string, defaultService?: string): Identifier | null {
  const text = raw.trim()
  if (!text) return null
  const url = handleFromUrl(text)
  if (url) return parseIdentifier(url)
  const m = SCHEME.exec(text)
  if (m && !/^https?$/i.test(m[1]!)) {
    const scheme = m[1]!.toLowerCase()
    const rest = m[2]!
    if (scheme === 'tel' || scheme === 'sms') return phoneDigits(rest) ? { kind: 'phone', value: rest.trim() } : null
    if (scheme === 'mailto') return looksLikeEmail(rest) ? { kind: 'email', value: normalEmail(rest) } : null
    // `xmpp:a@b.c` and the like are addresses on that service, not usernames to lowercase blindly,
    // but every service the networks report compares them without case.
    return { kind: 'username', service: scheme, value: normalUser(rest) }
  }
  if (looksLikeEmail(text)) return { kind: 'email', value: normalEmail(text) }
  if (looksLikePhone(text)) return { kind: 'phone', value: text }
  if (defaultService) return { kind: 'username', service: defaultService, value: normalUser(text) }
  return null
}

/** Every identifier on a card: its numbers, emails, usernames and profile links. */
export function cardIdentifiers(card: PersonPlaintext): Identifier[] {
  const out: Identifier[] = []
  for (const p of card.phones ?? []) if (phoneDigits(p.value)) out.push({ kind: 'phone', value: p.value })
  for (const e of card.emails ?? [])
    if (looksLikeEmail(e.value)) out.push({ kind: 'email', value: normalEmail(e.value) })
  for (const h of [...(card.handles ?? []), ...(card.urls ?? [])]) {
    const id = parseIdentifier(h.value)
    if (id?.kind === 'username') out.push(id)
  }
  return out
}

/** Every identifier a network reports for a contact, or its handle where it reports none. */
export function contactIdentifiers(contact: NetworkContact): Identifier[] {
  const raw = contact.profile.identifiers?.length ? contact.profile.identifiers : [contact.profile.handle ?? '']
  return raw.map((r) => parseIdentifier(r, contact.network)).filter((id): id is Identifier => id !== null)
}

/** A key that equal identifiers share; phone numbers share their last seven digits, then compare. */
function bucket(id: Identifier): string {
  if (id.kind === 'phone') return `tel:${phoneDigits(id.value)!.digits.slice(-MIN_PHONE_DIGITS)}`
  if (id.kind === 'email') return `mailto:${id.value}`
  return `${id.service}:${id.value}`
}

function same(a: Identifier, b: Identifier): boolean {
  if (a.kind === 'phone' && b.kind === 'phone') return samePhone(a.value, b.value)
  return bucket(a) === bucket(b)
}

/** Why a contact was suggested for a card. */
export type MatchReason = 'phone' | 'email' | 'username' | 'name'

export interface LinkSuggestion {
  personKey: string
  contact: NetworkContact
  reason: MatchReason
}

/** A name compared loosely: without case, accents or extra spaces. */
export function normalName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Which card each linked contact is on, by `contactKey`. */
export function linkIndex(people: readonly Person[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const { personKey, card } of people) {
    for (const link of card.links ?? []) out.set(contactKey(link), personKey)
  }
  return out
}

/**
 * Cards each contact not linked yet may belong on. A shared phone number, email or username
 * suggests a card; failing that, the exact same name does, when only one card has it. Every
 * suggestion is for the person to confirm: a number can be recycled, and names repeat.
 */
export function suggestLinks(people: readonly Person[], contacts: readonly NetworkContact[]): LinkSuggestion[] {
  const linked = linkIndex(people)
  const byBucket = new Map<string, { personKey: string; id: Identifier }[]>()
  const byName = new Map<string, string[]>()
  for (const { personKey, card } of people) {
    for (const id of cardIdentifiers(card)) {
      const key = bucket(id)
      const list = byBucket.get(key) ?? []
      list.push({ personKey, id })
      byBucket.set(key, list)
    }
    const name = normalName(card.name)
    if (name) byName.set(name, [...(byName.get(name) ?? []), personKey])
  }
  const out: LinkSuggestion[] = []
  for (const contact of contacts) {
    if (linked.has(contactKey(contact))) continue
    const found = new Map<string, MatchReason>()
    for (const id of contactIdentifiers(contact)) {
      for (const candidate of byBucket.get(bucket(id)) ?? []) {
        if (!found.has(candidate.personKey) && same(id, candidate.id)) {
          found.set(candidate.personKey, id.kind === 'username' ? 'username' : id.kind)
        }
      }
    }
    if (!found.size && contact.profile.name) {
      const named = byName.get(normalName(contact.profile.name)) ?? []
      if (named.length === 1) found.set(named[0]!, 'name')
    }
    for (const [personKey, reason] of found) out.push({ personKey, contact, reason })
  }
  return out
}

/**
 * Contacts on no card, in groups that share a phone number, email or username: the same
 * person on several networks, ready to become one card. A contact sharing nothing is a group
 * of its own.
 */
export function groupUnlinked(people: readonly Person[], contacts: readonly NetworkContact[]): NetworkContact[][] {
  const linked = linkIndex(people)
  const free = contacts.filter((c) => !linked.has(contactKey(c)))
  const parent = free.map((_, i) => i)
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)))
  const seen = new Map<string, { index: number; id: Identifier }[]>()
  free.forEach((contact, index) => {
    for (const id of contactIdentifiers(contact)) {
      const key = bucket(id)
      const list = seen.get(key) ?? []
      for (const other of list) if (same(id, other.id)) parent[root(index)] = root(other.index)
      list.push({ index, id })
      seen.set(key, list)
    }
  })
  const groups = new Map<number, NetworkContact[]>()
  free.forEach((contact, index) => {
    const r = root(index)
    groups.set(r, [...(groups.get(r) ?? []), contact])
  })
  return [...groups.values()]
}

/** Adds a value to a card's list unless an equal one is there. */
function addField(list: PersonField[], value: string, equal: (a: string, b: string) => boolean) {
  if (!list.some((f) => equal(f.value, value))) list.push({ value })
}

/**
 * Links contacts to a card, and copies onto it the numbers, emails and usernames the networks
 * know for them, so the card can start chats with them later. Taking them off any other card
 * is the caller's job (`moveLinks`).
 */
export function withLinks(card: PersonPlaintext, contacts: readonly NetworkContact[]): PersonPlaintext {
  const links = [...(card.links ?? [])]
  const phones = [...(card.phones ?? [])]
  const emails = [...(card.emails ?? [])]
  const handles = [...(card.handles ?? [])]
  for (const contact of contacts) {
    if (!links.some((l) => contactKey(l) === contactKey(contact))) {
      links.push({ network: contact.network, ghostId: contact.ghostId })
    }
    for (const id of contactIdentifiers(contact)) {
      if (id.kind === 'phone') addField(phones, id.value, samePhone)
      else if (id.kind === 'email') addField(emails, id.value, (a, b) => normalEmail(a) === normalEmail(b))
      // Internal IDs (`slack-internal:U123`) aren't usernames anyone would type or recognize.
      else if (!id.service.endsWith('-internal')) {
        addField(handles, `${id.service}:${id.value}`, (a, b) => {
          const x = parseIdentifier(a)
          const y = parseIdentifier(b)
          return !!x && !!y && bucket(x) === bucket(y)
        })
      }
    }
  }
  const out: PersonPlaintext = { ...card, links }
  if (phones.length) out.phones = phones
  if (emails.length) out.emails = emails
  if (handles.length) out.handles = handles
  return out
}

/** A new card for contacts that are one person, named after the first with a name. */
export function cardFromContacts(contacts: readonly NetworkContact[]): PersonPlaintext {
  const name = contacts.map((c) => c.profile.name?.trim()).find(Boolean) ?? contacts[0]?.profile.handle ?? ''
  return withLinks({ name }, contacts)
}

/** A card without these links: for taking contacts off a card, or moving them to another. */
export function withoutLinks(card: PersonPlaintext, links: readonly PersonLink[]): PersonPlaintext {
  const drop = new Set(links.map(contactKey))
  return { ...card, links: (card.links ?? []).filter((l) => !drop.has(contactKey(l))) }
}

/**
 * The cards that change when contacts are linked to `personKey`: that card with them, and any
 * other card they were on, without them. A contact is only ever on one card.
 */
export function moveLinks(people: readonly Person[], personKey: string, contacts: readonly NetworkContact[]): Person[] {
  const target = people.find((p) => p.personKey === personKey)
  if (!target) return []
  const moving = new Set(contacts.map(contactKey))
  const out: Person[] = [{ personKey, card: withLinks(target.card, contacts) }]
  for (const p of people) {
    if (p.personKey === personKey) continue
    if ((p.card.links ?? []).some((l) => moving.has(contactKey(l)))) {
      out.push({ personKey: p.personKey, card: withoutLinks(p.card, contacts) })
    }
  }
  return out
}

/**
 * Two cards as one, for duplicates: the first card's fields win, the second's fill in what it
 * lacks, and lists are combined without repeats.
 */
export function mergeCards(a: PersonPlaintext, b: PersonPlaintext): PersonPlaintext {
  const merged: PersonPlaintext = { ...b, ...stripEmpty(a) }
  const fields = (x?: PersonField[], y?: PersonField[], equal = (p: string, q: string) => p === q) => {
    const out = [...(x ?? [])]
    for (const f of y ?? []) if (!out.some((o) => equal(o.value, f.value))) out.push(f)
    return out.length ? out : undefined
  }
  merged.phones = fields(a.phones, b.phones, samePhone)
  merged.emails = fields(a.emails, b.emails, (p, q) => normalEmail(p) === normalEmail(q))
  merged.handles = fields(a.handles, b.handles)
  merged.urls = fields(a.urls, b.urls)
  const addresses = [...(a.addresses ?? []), ...(b.addresses ?? [])]
  merged.addresses = addresses.length ? addresses : undefined
  const links = [...(a.links ?? [])]
  for (const l of b.links ?? []) if (!links.some((x) => contactKey(x) === contactKey(l))) links.push(l)
  merged.links = links.length ? links : undefined
  if (a.note && b.note && a.note !== b.note) merged.note = `${a.note}\n\n${b.note}`
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key]
  return merged
}

function stripEmpty(card: PersonPlaintext): Partial<PersonPlaintext> {
  return Object.fromEntries(Object.entries(card).filter(([, v]) => v !== undefined && v !== '')) as PersonPlaintext
}

/** What a card is listed as: its name, else its organization, first email or number. */
export function cardTitle(card: PersonPlaintext): string {
  return (
    card.name.trim() ||
    [card.given, card.family].filter(Boolean).join(' ') ||
    card.org ||
    card.emails?.[0]?.value ||
    card.phones?.[0]?.value ||
    'No name'
  )
}
