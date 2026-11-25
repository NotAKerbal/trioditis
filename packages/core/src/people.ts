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
  /** What the person's own logins know them by (`ContactIdentifiersPlaintext`), if any has said. */
  identifiers?: string[]
  /** The accounts whose logins have sent the contact, where a chat with them can start. */
  networkAccountIds?: string[]
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

// Starting a chat from a typed number. The bridge host (apps/bridge-host/internal/connector,
// normalPhone and canonicalIdentifier) reads a number exactly as this does, and both are
// checked against the same cases (test/fixtures/phone-identifiers.json), so the client sends
// every number in one shape that both sides agree on:
//
//   normalPhone: an optional `tel:`/`sms:` scheme is dropped, and anything from an extension
//   (`x`, `ext`, `#`, `;`, `,`) on. What's left may hold only digits, spaces of any width,
//   `.`, `/`, `(`, `)`, any dash, and one leading `+`. `(0)` after a country code is dropped,
//   and a leading `00` is the international prefix, so it becomes `+`. The result is `+` and
//   7 to 15 digits (E.164's most) not starting with 0, or 7 to 15 national digits as written
//   (a trunk 0 kept: it's the network's to read). Anything else isn't a number.
//
// The bridge host must accept exactly these two shapes (`+` then digits, or digits alone).

/** Characters people write between a number's digits. */
const PHONE_PUNCTUATION = /[\s\u00a0\u2000-\u200b\u202f./()\-\u2010-\u2015\u2212]/g

/** A typed phone number as `+` and its digits, or its national digits; null if it isn't one. */
export function normalPhone(raw: string): string | null {
  let text = raw
    .trim()
    .replace(/^(?:tel|sms):/i, '')
    .split(/[;,#]|\s*(?:x|ext\.?|extension)\s*\d/i)[0]!
    .trim()
  // `+44 (0)20 …` and `0044 (0)20 …`: the bracketed trunk 0 isn't dialled with the country code.
  text = text.replace(/^((?:\+|00)\s*\d{1,3})[\s\u00a0]*\(0\)/, '$1')
  const plus = text.startsWith('+')
  const rest = (plus ? text.slice(1) : text).replace(PHONE_PUNCTUATION, '')
  if (!/^\d+$/.test(rest)) return null
  let digits = rest
  let international = plus
  if (!plus && digits.startsWith('00')) {
    digits = digits.slice(2)
    international = true
  }
  if (digits.length < MIN_PHONE_DIGITS || digits.length > 15) return null
  // No country code starts with 0.
  if (international && digits.startsWith('0')) return null
  return international ? `+${digits}` : digits
}

/** Networks whose connectors find someone by number only with its country code. Mirrors the bridge host's internationalOnly. */
export const PHONE_NEEDS_COUNTRY_CODE: readonly Network[] = ['signal', 'imessage']

/** Networks that read a number without `+` as international. Mirrors the bridge host's countryCodeFirst. */
export const PHONE_COUNTRY_CODE_FIRST: readonly Network[] = ['whatsapp']

/** Why a typed identifier can't start a chat on a network, before it's sent. */
export type StartIdentifierProblem = 'needs_country_code' | 'phone_only' | 'username_only' | 'not_a_number'

/**
 * What to send to start a chat from what someone typed: a number in `normalPhone`'s shape, or a
 * username without its `@`. A problem instead when the network can't start from it, so the
 * person hears why rather than "no one has that number".
 */
export function startIdentifier(
  raw: string,
  network: Network,
  targets: { phone: boolean; username: boolean },
): { identifier: string } | { problem: StartIdentifierProblem } {
  const text = raw.trim()
  // A valid number is one, extension and all (`;ext=89` has letters); otherwise letters or an
  // `@` make it a username. The bridge host decides the same way (canonicalIdentifier).
  const meantAsNumber =
    normalPhone(text) !== null ||
    !/[a-z@_]/i.test(text.replace(/^(?:tel|sms):/i, '').replace(/\s*(?:x|ext\.?|extension)\s*\d+$/i, ''))
  // Where only usernames work, digits alone can be one (X allows it); a `+` or a number's
  // punctuation can't.
  if (meantAsNumber && !targets.phone && targets.username && /^\d+$/.test(text)) return { identifier: text }
  if (meantAsNumber) {
    if (!targets.phone) return { problem: 'username_only' }
    const phone = normalPhone(text)
    if (!phone) return { problem: 'not_a_number' }
    if (!phone.startsWith('+') && PHONE_NEEDS_COUNTRY_CODE.includes(network)) return { problem: 'needs_country_code' }
    // WhatsApp reads digits without a + as international; a leading 0 is a national number
    // (bridge host's countryCodeFirst), which would look up someone else.
    if (!phone.startsWith('+') && phone.startsWith('0') && PHONE_COUNTRY_CODE_FIRST.includes(network)) {
      return { problem: 'needs_country_code' }
    }
    return { identifier: phone }
  }
  if (!targets.username) return { problem: 'phone_only' }
  return { identifier: text.replace(/^@/, '') }
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

/**
 * Every identifier the person's own logins know a contact by. Not the profile's handle: a
 * profile is shared by every member with the contact, and its handle can be what another
 * member's login learned.
 */
export function contactIdentifiers(contact: NetworkContact): Identifier[] {
  const raw = contact.identifiers ?? []
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

/**
 * Whether two identifiers are certainly the same: numbers with the same digits, not just the
 * same ending. A number without its country code can end two different full numbers, so it
 * can't join them into one person.
 */
function exactlySame(a: Identifier, b: Identifier): boolean {
  if (a.kind === 'phone' && b.kind === 'phone') {
    const x = phoneDigits(a.value)!
    const y = phoneDigits(b.value)!
    return x.digits === y.digits && x.international === y.international
  }
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
 * Contacts on no card, in groups that share a phone number, email or username exactly: the
 * same person on several networks, ready to become one card. A contact sharing nothing is a
 * group of its own.
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
      for (const other of list) if (exactlySame(id, other.id)) parent[root(index)] = root(other.index)
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

/** What linking added to a card: the links, and the numbers, emails and usernames copied with them. */
export interface LinkChange {
  links: PersonLink[]
  phones: string[]
  emails: string[]
  handles: string[]
}

/** What a card gained from `before` to `after`, so a link can be undone (`withoutLinkChange`). */
export function linkChange(before: PersonPlaintext, after: PersonPlaintext): LinkChange {
  const gained = (was: readonly PersonField[] = [], now: readonly PersonField[] = []) => {
    const had = new Set(was.map((f) => f.value))
    return now.map((f) => f.value).filter((v) => !had.has(v))
  }
  const linked = new Set((before.links ?? []).map(contactKey))
  return {
    links: (after.links ?? []).filter((l) => !linked.has(contactKey(l))),
    phones: gained(before.phones, after.phones),
    emails: gained(before.emails, after.emails),
    handles: gained(before.handles, after.handles),
  }
}

/**
 * A card without what a link added to it. Only what the link itself added goes, as it added it:
 * a number the card already had stays, and so does one labelled since, or anything else changed.
 */
export function withoutLinkChange(card: PersonPlaintext, change: LinkChange): PersonPlaintext {
  const out = withoutLinks(card, change.links)
  for (const key of ['phones', 'emails', 'handles'] as const) {
    const drop = new Set(change[key])
    const kept = (out[key] ?? []).filter((f) => !(drop.has(f.value) && !f.label))
    if (kept.length) out[key] = kept
    else delete out[key]
  }
  return out
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

/** An identifier as a string equal only for the very same number, address or username. */
function exactKey(id: Identifier): string {
  if (id.kind !== 'phone') return bucket(id)
  const { digits, international } = phoneDigits(id.value)!
  return `tel:${international ? '+' : ''}${digits}`
}

/** Two lists of fields as one: the card's own first, then the file's it doesn't have yet. */
function unionFields(
  mine: readonly PersonField[] | undefined,
  theirs: readonly PersonField[] | undefined,
  key: (value: string) => string,
): PersonField[] | undefined {
  const out = [...(mine ?? [])]
  const seen = new Set(out.map((f) => key(f.value)))
  for (const f of theirs ?? []) {
    if (seen.has(key(f.value))) continue
    seen.add(key(f.value))
    out.push(f)
  }
  return out.length ? out : undefined
}

const phoneKey = (value: string) => {
  const d = phoneDigits(value)
  return d ? `tel:${d.international ? '+' : ''}${d.digits}` : value.trim()
}
const handleKey = (value: string) => {
  const id = parseIdentifier(value)
  return id ? bucket(id) : value.trim().toLowerCase()
}

/**
 * A card already here with what a file says about the same person added to it. Reimporting an
 * older export mustn't take away what was added here since: numbers, emails, usernames, links
 * and addresses are put together, a note written here stays, and a field the file leaves out
 * stays as it is. A field the file has replaces the card's (a new job title, say).
 */
function merged(now: PersonPlaintext, file: PersonPlaintext): PersonPlaintext {
  const next: PersonPlaintext = { ...now }
  for (const [key, value] of Object.entries(file)) {
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue
    next[key] = value
  }
  const set = (key: 'phones' | 'emails' | 'handles' | 'urls', list: PersonField[] | undefined) => {
    if (list) next[key] = list
    else delete next[key]
  }
  set('phones', unionFields(now.phones, file.phones, phoneKey))
  set(
    'emails',
    unionFields(now.emails, file.emails, (v) => normalEmail(v)),
  )
  set('handles', unionFields(now.handles, file.handles, handleKey))
  set(
    'urls',
    unionFields(now.urls, file.urls, (v) => v.trim()),
  )
  const addresses = [...(now.addresses ?? [])]
  for (const a of file.addresses ?? []) {
    if (!addresses.some((b) => JSON.stringify(b) === JSON.stringify(a))) addresses.push(a)
  }
  if (addresses.length) next.addresses = addresses
  if (now.note?.trim()) next.note = now.note
  if (now.links?.length) next.links = now.links
  if (now.uid) next.uid = now.uid
  return next
}

/**
 * The cards an import makes or changes, worked out from the cards there are now. An entry goes
 * to a card already here that is the same person: one with its UID, or, for an entry without
 * a UID match (a CSV row has none, and Google's and Outlook's exports have none), the one card
 * with the same name and the same number, email or username exactly. A name alone never
 * matches: two people can share one. An entry that matches several cards isn't guessed at; it's
 * left out and reported through `ambiguous`. A matched card keeps what it has and gains what
 * the file adds (merged), so importing a file again, even an older one, takes nothing away; a
 * UID the file repeats is one card, and each card here is matched by one entry at most. Every
 * other entry gets the key `keyFor` gives its place in the file, so working the import out
 * again later (after another device changed the address book) gives the same cards, and keeps
 * the links they have by then. Cards that wouldn't change are left out.
 */
export function planImport(
  existing: readonly Person[],
  imported: readonly PersonPlaintext[],
  keyFor: (index: number) => string,
  /** Told which card each entry went to, for a caller that tracks entries across plans. */
  placed?: (index: number, personKey: string) => void,
  /**
   * Whether a card here may be matched by identity: not one this same import made, which a
   * later plan sees as existing.
   */
  matchable: (personKey: string) => boolean = () => true,
  /** Told of each entry left out because it matches more than one card. */
  ambiguous?: (index: number) => void,
): Person[] {
  const byUid = new Map(existing.filter((p) => p.card.uid).map((p) => [p.card.uid!, p]))
  const byKey = new Map(existing.map((p) => [p.personKey, p]))
  const byName = new Map<string, { person: Person; ids: Set<string> }[]>()
  for (const person of [...existing].sort((a, b) => (a.personKey < b.personKey ? -1 : 1))) {
    if (!matchable(person.personKey)) continue
    const name = normalName(person.card.name)
    const list = byName.get(name) ?? []
    list.push({ person, ids: new Set(cardIdentifiers(person.card).map(exactKey)) })
    byName.set(name, list)
  }
  const claimed = new Set<string>()
  const keyForUid = new Map<string, string>()
  const out = new Map<string, Person>()
  /** The one card this entry is, null when several could be, undefined when none is. */
  const sameAs = (card: PersonPlaintext): string | null | undefined => {
    const ids = cardIdentifiers(card).map(exactKey)
    if (!ids.length) return undefined
    const matches = (byName.get(normalName(card.name)) ?? []).filter(
      ({ person, ids: theirs }) =>
        // Cards from two sources with their own UIDs are two cards.
        (!card.uid || !person.card.uid) && ids.some((id) => theirs.has(id)),
    )
    if (matches.length > 1) return null
    const only = matches[0]?.person.personKey
    return only && !claimed.has(only) ? only : undefined
  }
  imported.forEach((card, index) => {
    let personKey = byUid.get(card.uid ?? '')?.personKey ?? (card.uid ? keyForUid.get(card.uid) : undefined)
    if (!personKey) {
      const same = sameAs(card)
      if (same === null) return ambiguous?.(index)
      personKey = same ?? keyFor(index)
    }
    if (card.uid) keyForUid.set(card.uid, personKey)
    claimed.add(personKey)
    placed?.(index, personKey)
    const now = out.get(personKey)?.card ?? byKey.get(personKey)?.card
    out.set(personKey, { personKey, card: now ? merged(now, card) : { ...card } })
  })
  return [...out.values()].filter((p) => JSON.stringify(byKey.get(p.personKey)?.card) !== JSON.stringify(p.card))
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
