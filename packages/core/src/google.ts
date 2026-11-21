import type { PersonAddress, PersonField, PersonPlaintext } from './people.ts'

// Google Contacts, read straight from the person's Google account: the People API's
// `people.connections.list`, which the client calls itself with a token only it holds, so the
// server never sees the contacts or the token. See docs/architecture/client-api.md, People.

/** Read-only access to the person's contacts, and nothing else of their Google account. */
export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly'

/** What each contact is read with: everything a card holds. */
export const GOOGLE_PERSON_FIELDS = [
  'names',
  'nicknames',
  'organizations',
  'phoneNumbers',
  'emailAddresses',
  'urls',
  'addresses',
  'birthdays',
  'biographies',
  'photos',
].join(',')

/** An OAuth client ID as Google Cloud makes them: `<project number>-<id>.apps.googleusercontent.com`. */
const CLIENT_ID = /^[0-9]{4,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/

/** Why a Google client ID won't do, or null when it will. */
export function googleClientIdProblem(clientId: string): string | null {
  if (!clientId.trim()) return 'Enter the client ID.'
  if (!CLIENT_ID.test(clientId.trim()))
    return 'That isn’t a Google OAuth client ID. It ends in .apps.googleusercontent.com.'
  return null
}

// The parts of the People API's Person that a card is made from.
interface GoogleValue {
  value?: string
  type?: string
  formattedType?: string
  metadata?: { primary?: boolean }
}
interface GoogleDate {
  year?: number
  month?: number
  day?: number
}
export interface GooglePerson {
  resourceName?: string
  names?: {
    displayName?: string
    givenName?: string
    familyName?: string
    middleName?: string
    honorificPrefix?: string
    honorificSuffix?: string
  }[]
  nicknames?: { value?: string }[]
  organizations?: { name?: string; title?: string }[]
  phoneNumbers?: GoogleValue[]
  emailAddresses?: GoogleValue[]
  urls?: GoogleValue[]
  addresses?: {
    type?: string
    formattedType?: string
    streetAddress?: string
    extendedAddress?: string
    city?: string
    region?: string
    postalCode?: string
    country?: string
    formattedValue?: string
  }[]
  birthdays?: { date?: GoogleDate; text?: string }[]
  biographies?: { value?: string }[]
  photos?: { url?: string; default?: boolean }[]
}

/** One page of `people.connections.list`. */
export interface GoogleConnectionsPage {
  connections?: GooglePerson[]
  nextPageToken?: string
}

// Google's own types, as the labels cards use (vcard.ts reads the same from a file).
const LABELS: Record<string, string> = {
  mobile: 'mobile',
  home: 'home',
  work: 'work',
  main: 'main',
  other: 'other',
  homeFax: 'home fax',
  workFax: 'work fax',
  otherFax: 'fax',
  pager: 'pager',
  workMobile: 'work mobile',
  workPager: 'work pager',
  googleVoice: 'google voice',
  homePage: 'homepage',
  blog: 'blog',
  profile: 'profile',
}

/** A value's label: Google's type as a card names it, or the person's own label as they typed it. */
function labelOf(type: string | undefined): string | undefined {
  const t = type?.trim()
  if (!t) return undefined
  return LABELS[t] ?? t.toLowerCase()
}

const text = (s: string | undefined) => s?.trim() || undefined

/** The values, primary first, each once. */
function fields(values: readonly GoogleValue[] | undefined, same = (v: string) => v): PersonField[] {
  const sorted = [...(values ?? [])].sort((a, b) => Number(!!b.metadata?.primary) - Number(!!a.metadata?.primary))
  const seen = new Set<string>()
  const out: PersonField[] = []
  for (const v of sorted) {
    const value = text(v.value)
    if (!value || seen.has(same(value))) continue
    seen.add(same(value))
    const label = labelOf(v.type)
    out.push(label ? { value, label } : { value })
  }
  return out
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD`, or `--MM-DD` without a year, as cards hold a birthday. */
function birthdayOf(birthdays: GooglePerson['birthdays']): string | undefined {
  for (const b of birthdays ?? []) {
    const d = b.date
    if (!d?.month || !d.day || d.month > 12 || d.day > 31) continue
    return d.year
      ? `${String(d.year).padStart(4, '0')}-${pad(d.month)}-${pad(d.day)}`
      : `--${pad(d.month)}-${pad(d.day)}`
  }
  return undefined
}

/**
 * A card for a Google contact, with the address of its photo to fetch (Google's placeholder
 * initials are left out), or null for one with nothing to show. Its UID is the contact's
 * resource name, so reading the account again updates the cards it made.
 */
export function cardFromGoogle(person: GooglePerson): { card: PersonPlaintext; photoUrl?: string } | null {
  const n = person.names?.[0]
  const phones = fields(person.phoneNumbers, (v) => v.replace(/[^\d+]/g, ''))
  const emails = fields(person.emailAddresses, (v) => v.toLowerCase())
  const urls = fields(person.urls)
  const org = person.organizations?.find((o) => text(o.name) || text(o.title))
  const name =
    text(n?.displayName) ??
    ([n?.givenName, n?.familyName].map(text).filter(Boolean).join(' ') || undefined) ??
    text(person.nicknames?.[0]?.value) ??
    text(org?.name) ??
    emails[0]?.value ??
    phones[0]?.value
  if (!name) return null

  const card: PersonPlaintext = { name }
  const set = <K extends keyof PersonPlaintext>(key: K, value: PersonPlaintext[K] | undefined) => {
    if (value !== undefined && !(Array.isArray(value) && !value.length)) card[key] = value
  }
  set('given', text(n?.givenName))
  set('family', text(n?.familyName))
  set('middle', text(n?.middleName))
  set('prefix', text(n?.honorificPrefix))
  set('suffix', text(n?.honorificSuffix))
  set('nickname', text(person.nicknames?.[0]?.value))
  set('org', text(org?.name))
  set('title', text(org?.title))
  set('phones', phones)
  set('emails', emails)
  set('urls', urls)
  const addresses: PersonAddress[] = []
  for (const a of person.addresses ?? []) {
    const street = [a.streetAddress, a.extendedAddress].map(text).filter(Boolean).join('\n') || undefined
    const address: PersonAddress = {}
    const label = labelOf(a.type)
    if (label) address.label = label
    if (street) address.street = street
    if (text(a.city)) address.locality = text(a.city)
    if (text(a.region)) address.region = text(a.region)
    if (text(a.postalCode)) address.postcode = text(a.postalCode)
    if (text(a.country)) address.country = text(a.country)
    // An address Google only has as one line is kept as its street.
    if (!street && !address.locality && text(a.formattedValue)) address.street = text(a.formattedValue)
    if (Object.keys(address).some((k) => k !== 'label')) addresses.push(address)
  }
  set('addresses', addresses)
  set('birthday', birthdayOf(person.birthdays))
  set('note', text(person.biographies?.[0]?.value))
  const resourceName = text(person.resourceName)
  if (resourceName) card.uid = `google:${resourceName}`
  const photoUrl = person.photos?.find((p) => !p.default && p.url?.startsWith('https://'))?.url
  return photoUrl ? { card, photoUrl } : { card }
}

/** Google's sign-in page, asking for read-only access to contacts, which answers to `redirectUri`. */
export function googleSignInUrl({
  clientId,
  redirectUri,
  state,
}: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    // The token comes back in the address's fragment, which the browser never sends anywhere:
    // the client reads the contacts itself, and no server ever holds the token.
    response_type: 'token',
    scope: GOOGLE_CONTACTS_SCOPE,
    state,
    include_granted_scopes: 'false',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}
