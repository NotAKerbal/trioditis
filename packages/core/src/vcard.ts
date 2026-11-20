// Reading and writing the files address books export: vCard (`.vcf`, versions 2.1, 3.0 and
// 4.0: iPhone and iCloud, Android, Google Contacts, Outlook, macOS) and the CSV that Google
// Contacts and Outlook also offer. All of it runs on the person's device; the cards are sealed
// before they leave it.

import { handleFromUrl, type PersonAddress, type PersonField, type PersonPlaintext } from './people.ts'

interface Property {
  group: string
  name: string
  params: Map<string, string[]>
  value: string
}

/** The most cards one file gives, as many as an address book can hold (people.ts, MAX_PEOPLE). */
export const MAX_IMPORT_CARDS = 10_000

/** Splits `text` on `separator`, except where it's escaped with a backslash. */
function splitEscaped(text: string, separator: string): string[] {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1]
      i++
    } else if (ch === separator) {
      out.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

function unescapeText(text: string): string {
  return text.replace(/\\([nN,;:\\])/g, (_, ch: string) => (ch === 'n' || ch === 'N' ? '\n' : ch))
}

function decodeQuotedPrintable(text: string, charset: string): string {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(...new TextEncoder().encode(ch))
    }
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes))
  } catch {
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
}

/**
 * The file's logical lines: folded lines (a continuation starts with a space or tab) joined,
 * and vCard 2.1's quoted-printable soft line breaks (a line ending in `=`) too.
 */
function logicalLines(text: string): string[] {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  const out: string[] = []
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]!
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1)
      continue
    }
    if (/;\s*(?:ENCODING=)?QUOTED-PRINTABLE[;:]/i.test(line.split(':')[0] + ':')) {
      while (line.endsWith('=') && i + 1 < raw.length) line = line.slice(0, -1) + raw[++i]!
    }
    out.push(line)
  }
  return out
}

function parseProperty(line: string): Property | null {
  // The name and parameters end at the first colon outside a quoted parameter value.
  let colon = -1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const [head, ...rawParams] = line.slice(0, colon).split(';')
  const dot = head!.lastIndexOf('.')
  const params = new Map<string, string[]>()
  for (const raw of rawParams) {
    const eq = raw.indexOf('=')
    // vCard 2.1 writes types bare: `TEL;CELL;HOME:`.
    const key = eq < 0 ? 'TYPE' : raw.slice(0, eq).toUpperCase()
    const values = (eq < 0 ? raw : raw.slice(eq + 1)).split(',').map((v) => v.replace(/^"|"$/g, ''))
    if (eq < 0 && /^(QUOTED-PRINTABLE|BASE64|B|8BIT)$/i.test(raw)) params.set('ENCODING', [raw])
    else params.set(key, [...(params.get(key) ?? []), ...values])
  }
  let value = line.slice(colon + 1)
  const encoding = params.get('ENCODING')?.[0]?.toUpperCase()
  if (encoding === 'QUOTED-PRINTABLE') value = decodeQuotedPrintable(value, params.get('CHARSET')?.[0] ?? 'utf-8')
  return {
    group: dot < 0 ? '' : head!.slice(0, dot).toLowerCase(),
    name: (dot < 0 ? head! : head!.slice(dot + 1)).toUpperCase(),
    params,
    value,
  }
}

// TYPE values that only say how a number or address is used by machines, not what to call it.
const IGNORED_TYPES = new Set(['pref', 'voice', 'internet', 'x400', 'msg', 'text', 'textphone', 'uri'])
const TYPE_LABELS: Record<string, string> = {
  cell: 'mobile',
  mobile: 'mobile',
  iphone: 'iPhone',
  home: 'home',
  work: 'work',
  main: 'main',
  fax: 'fax',
  pager: 'pager',
  other: 'other',
}

/** The label a property was saved under: Apple's `X-ABLabel` for its group, or its TYPE. */
function labelOf(prop: Property, groupLabels: Map<string, string>): string | undefined {
  const custom = prop.group ? groupLabels.get(prop.group) : undefined
  if (custom) return custom
  const types = (prop.params.get('TYPE') ?? []).map((t) => t.toLowerCase()).filter((t) => !IGNORED_TYPES.has(t))
  if (types.includes('fax')) return types.includes('work') ? 'work fax' : types.includes('home') ? 'home fax' : 'fax'
  const known = types.map((t) => TYPE_LABELS[t]).find(Boolean)
  return known ?? (types[0] ? types[0].replace(/^x-/, '') : undefined)
}

/** Apple writes its built-in labels as `_$!<Mobile>!$_`. */
function abLabel(value: string): string {
  const m = /^_\$!<(.+)>!\$_$/.exec(value.trim())
  return (m ? m[1]!.toLowerCase() : unescapeText(value)).trim()
}

function normalBirthday(raw: string): string | undefined {
  const text = raw.trim()
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(text)
  if (m) return m[1] === '1604' ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}` // Apple's "no year"
  m = /^--(\d{2})-?(\d{2})/.exec(text)
  if (m) return `--${m[1]}-${m[2]}`
  return undefined
}

/** A PHOTO's value as a data URL; a photo at a web address isn't fetched. */
function photoOf(prop: Property): string | undefined {
  const value = prop.value.trim().replace(/\s+/g, '')
  if (/^data:image\/[a-z+.-]+;base64,/i.test(value)) return value
  const encoding = prop.params.get('ENCODING')?.[0]?.toUpperCase()
  if (encoding !== 'B' && encoding !== 'BASE64') return undefined
  const type = (prop.params.get('TYPE') ?? []).find((t) => /^(jpe?g|png|gif|webp|image\/.+)$/i.test(t))?.toLowerCase()
  const mime = !type ? 'image/jpeg' : type.startsWith('image/') ? type : `image/${type === 'jpg' ? 'jpeg' : type}`
  return `data:${mime};base64,${value}`
}

function cardFrom(props: Property[]): PersonPlaintext | null {
  const groupLabels = new Map<string, string>()
  for (const p of props) if (p.name === 'X-ABLABEL' && p.group) groupLabels.set(p.group, abLabel(p.value))
  const card: PersonPlaintext = { name: '' }
  const phones: PersonField[] = []
  const emails: PersonField[] = []
  const handles: PersonField[] = []
  const urls: PersonField[] = []
  const addresses: PersonAddress[] = []
  const field = (p: Property, value: string): PersonField => {
    const label = labelOf(p, groupLabels)
    return label ? { value, label } : { value }
  }
  for (const p of props) {
    const text = () => unescapeText(p.value).trim()
    switch (p.name) {
      case 'FN':
        card.name = text()
        break
      case 'N': {
        const [family, given, middle, prefix, suffix] = splitEscaped(p.value, ';').map((s) => unescapeText(s).trim())
        Object.assign(card, {
          ...(family ? { family } : {}),
          ...(given ? { given } : {}),
          ...(middle ? { middle } : {}),
          ...(prefix ? { prefix } : {}),
          ...(suffix ? { suffix } : {}),
        })
        break
      }
      case 'NICKNAME':
        if (text()) card.nickname = text()
        break
      case 'ORG': {
        const org = splitEscaped(p.value, ';')
          .map((s) => unescapeText(s).trim())
          .filter(Boolean)
          .join(', ')
        if (org) card.org = org
        break
      }
      case 'TITLE':
        if (text()) card.title = text()
        break
      case 'TEL':
        if (text()) phones.push(field(p, text().replace(/^tel:/i, '')))
        break
      case 'EMAIL':
        if (text()) emails.push(field(p, text().replace(/^mailto:/i, '')))
        break
      case 'IMPP':
        if (text()) handles.push(field(p, text()))
        break
      case 'X-SOCIALPROFILE': {
        // Apple: `X-SOCIALPROFILE;type=twitter;x-user=alice:https://twitter.com/alice`. Its
        // TYPE names the service, so it isn't a label.
        const service = p.params.get('TYPE')?.[0]?.toLowerCase()
        const user = p.params.get('X-USER')?.[0]
        const fromUrl = handleFromUrl(text())
        if (fromUrl) handles.push({ value: fromUrl })
        else if (service && user) handles.push({ value: `${service}:${user}` })
        else if (text()) urls.push({ value: text() })
        break
      }
      case 'X-TELEGRAM':
      case 'X-SKYPE':
      case 'X-SKYPE-USERNAME':
      case 'X-JABBER':
      case 'X-AIM':
      case 'X-ICQ':
      case 'X-YAHOO':
      case 'X-MSN':
      case 'X-TWITTER': {
        const service = p.name.slice(2).toLowerCase().replace('-username', '').replace('jabber', 'xmpp')
        if (text()) handles.push(field(p, `${service}:${text().replace(/^@/, '')}`))
        break
      }
      case 'URL': {
        const handle = handleFromUrl(text())
        if (handle) handles.push(field(p, handle))
        else if (text()) urls.push(field(p, text()))
        break
      }
      case 'ADR': {
        const [pobox, ext, street, locality, region, postcode, country] = splitEscaped(p.value, ';').map((s) =>
          unescapeText(s).trim(),
        )
        const address: PersonAddress = {}
        const streetLine = [pobox, ext, street].filter(Boolean).join('\n')
        if (streetLine) address.street = streetLine
        if (locality) address.locality = locality
        if (region) address.region = region
        if (postcode) address.postcode = postcode
        if (country) address.country = country
        const label = labelOf(p, groupLabels)
        if (label) address.label = label
        if (Object.keys(address).some((k) => k !== 'label')) addresses.push(address)
        break
      }
      case 'BDAY': {
        const birthday = normalBirthday(text())
        if (birthday) card.birthday = birthday
        break
      }
      case 'NOTE':
        if (text()) card.note = text()
        break
      case 'PHOTO': {
        const photo = photoOf(p)
        if (photo) card.photo = photo
        break
      }
      case 'UID':
        if (text()) card.uid = text()
        break
    }
  }
  if (phones.length) card.phones = phones
  if (emails.length) card.emails = emails
  if (handles.length) card.handles = handles
  if (urls.length) card.urls = urls
  if (addresses.length) card.addresses = addresses
  if (!card.name) {
    card.name = [card.prefix, card.given, card.middle, card.family, card.suffix].filter(Boolean).join(' ')
  }
  if (!card.name) card.name = card.org ?? card.nickname ?? emails[0]?.value ?? phones[0]?.value ?? ''
  return card.name || phones.length || emails.length || handles.length ? card : null
}

/** The cards in a `.vcf` file. One that names no one and has no number, email or username is skipped. */
export function parseVCards(text: string): PersonPlaintext[] {
  const cards: PersonPlaintext[] = []
  let current: Property[] | null = null
  for (const line of logicalLines(text)) {
    if (!line.trim()) continue
    if (/^BEGIN:VCARD$/i.test(line.trim())) {
      current = []
      continue
    }
    if (/^END:VCARD$/i.test(line.trim())) {
      const card = current && cardFrom(current)
      if (card) cards.push(card)
      if (cards.length >= MAX_IMPORT_CARDS) break
      current = null
      continue
    }
    const prop = current && parseProperty(line)
    if (prop) current!.push(prop)
  }
  return cards
}

// Writing vCard 3.0: the version every address book still imports.

function escapeText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
}

/** Folds a line at 75 bytes, never inside a character, as RFC 6350 asks. */
function fold(line: string): string {
  const encoder = new TextEncoder()
  const parts: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const size = encoder.encode(ch).length
    if (bytes + size > (parts.length ? 74 : 75)) {
      parts.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += size
  }
  parts.push(current)
  return parts.join('\r\n ')
}

const TYPE_FOR_LABEL: Record<string, string> = {
  mobile: 'CELL',
  iphone: 'IPHONE',
  home: 'HOME',
  work: 'WORK',
  main: 'MAIN',
  fax: 'FAX',
  'home fax': 'HOME,FAX',
  'work fax': 'WORK,FAX',
  pager: 'PAGER',
  other: 'OTHER',
}

/** The cards as one `.vcf` file. */
export function toVCards(cards: readonly PersonPlaintext[]): string {
  const out: string[] = []
  for (const card of cards) {
    let item = 0
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeText(card.name)}`]
    lines.push(
      `N:${[card.family, card.given, card.middle, card.prefix, card.suffix].map((s) => escapeText(s ?? '')).join(';')}`,
    )
    if (card.nickname) lines.push(`NICKNAME:${escapeText(card.nickname)}`)
    if (card.org) lines.push(`ORG:${escapeText(card.org)}`)
    if (card.title) lines.push(`TITLE:${escapeText(card.title)}`)
    // A label vCard has no TYPE for goes on Apple's X-ABLabel, which others ignore harmlessly.
    const labelled = (name: string, value: string, label: string | undefined, extraType?: string) => {
      const type = label ? TYPE_FOR_LABEL[label.toLowerCase()] : undefined
      const types = [extraType, type].filter(Boolean).join(',')
      if (label && !type) {
        item++
        lines.push(`item${item}.${name}${extraType ? `;TYPE=${extraType}` : ''}:${value}`)
        lines.push(`item${item}.X-ABLabel:${escapeText(label)}`)
      } else {
        lines.push(`${name}${types ? `;TYPE=${types}` : ''}:${value}`)
      }
    }
    for (const p of card.phones ?? []) labelled('TEL', escapeText(p.value), p.label)
    for (const e of card.emails ?? []) labelled('EMAIL', escapeText(e.value), e.label, 'INTERNET')
    for (const h of card.handles ?? []) labelled('IMPP', escapeText(h.value), h.label)
    for (const u of card.urls ?? []) labelled('URL', escapeText(u.value), u.label)
    for (const a of card.addresses ?? []) {
      const parts = ['', '', a.street, a.locality, a.region, a.postcode, a.country].map((s) => escapeText(s ?? ''))
      labelled('ADR', parts.join(';'), a.label)
    }
    if (card.birthday) lines.push(`BDAY:${card.birthday}`)
    if (card.note) lines.push(`NOTE:${escapeText(card.note)}`)
    const photo = card.photo && /^data:image\/([a-z+.-]+);base64,(.+)$/i.exec(card.photo)
    if (photo) lines.push(`PHOTO;ENCODING=b;TYPE=${photo[1]!.toUpperCase()}:${photo[2]}`)
    if (card.uid) lines.push(`UID:${escapeText(card.uid)}`)
    lines.push('END:VCARD')
    out.push(...lines.map(fold))
  }
  return out.length ? out.join('\r\n') + '\r\n' : ''
}

// CSV: Google Contacts ("First Name", "Phone 1 - Value", "E-mail 1 - Label", …, and the older
// "Given Name", "Phone 1 - Type") and Outlook ("First Name", "Mobile Phone", "E-mail Address").

/** The rows of an RFC 4180 CSV: quoted fields can hold commas, quotes and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((f) => f.trim()))
}

/** Google puts several values in one cell with ` ::: ` between them. */
const values = (cell: string | undefined) =>
  (cell ?? '')
    .split(' ::: ')
    .map((v) => v.trim())
    .filter(Boolean)

/** Google's labels start with `* ` for the primary one. */
const csvLabel = (raw: string | undefined) =>
  raw
    ?.replace(/^\*\s*/, '')
    .trim()
    .toLowerCase() || undefined

/** The cards in a Google Contacts or Outlook CSV export. */
export function parseContactsCsv(text: string): PersonPlaintext[] {
  const [header, ...rows] = parseCsv(text)
  if (!header) return []
  const columns = header.map((h) => h.trim().toLowerCase())
  const col = (...names: string[]) => columns.findIndex((c) => names.includes(c))
  const at = {
    name: col('name', 'display name', 'full name'),
    given: col('first name', 'given name'),
    middle: col('middle name', 'additional name'),
    family: col('last name', 'family name', 'surname'),
    prefix: col('name prefix', 'title'),
    suffix: col('name suffix', 'suffix'),
    nickname: col('nickname'),
    org: col('organization name', 'organization 1 - name', 'company'),
    title: col('organization title', 'organization 1 - title', 'job title'),
    birthday: col('birthday'),
    note: col('notes', 'note'),
  }
  const cards: PersonPlaintext[] = []
  for (const row of rows.slice(0, MAX_IMPORT_CARDS)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
    const card: PersonPlaintext = { name: cell(at.name) }
    for (const key of ['given', 'middle', 'family', 'prefix', 'suffix', 'nickname', 'org', 'title', 'note'] as const) {
      const value = cell(at[key])
      if (value) card[key] = value
    }
    const birthday = normalBirthday(cell(at.birthday))
    if (birthday) card.birthday = birthday
    const phones: PersonField[] = []
    const emails: PersonField[] = []
    const handles: PersonField[] = []
    const urls: PersonField[] = []
    const addresses: PersonAddress[] = []
    columns.forEach((c, i) => {
      // Google: "Phone 1 - Value" with its label in "Phone 1 - Label" (or "- Type").
      const numbered = /^(.+?) - value$/.exec(c)
      if (numbered) {
        const labelAt = col(`${numbered[1]} - label`, `${numbered[1]} - type`)
        const label = csvLabel(cell(labelAt))
        const kind = numbered[1]!
        for (const value of values(row[i])) {
          const f: PersonField = label ? { value, label } : { value }
          if (/^phone \d+$/.test(kind)) phones.push(f)
          else if (/^e-?mail \d+$/.test(kind)) emails.push(f)
          else if (/^website \d+$/.test(kind)) {
            const handle = handleFromUrl(value)
            if (handle) handles.push({ value: handle })
            else urls.push(f)
          } else if (/^im \d+$/.test(kind)) {
            const service = csvLabel(cell(col(`${kind} - service`, `${kind} - protocol`)))
            handles.push({ value: service ? `${service}:${value.replace(/^@/, '')}` : value })
          }
        }
        return
      }
      const formatted = /^address \d+ - formatted$/.exec(c)
      if (formatted && cell(i)) {
        const label = csvLabel(cell(col(c.replace('formatted', 'label'), c.replace('formatted', 'type'))))
        addresses.push(label ? { street: cell(i), label } : { street: cell(i) })
        return
      }
      // Outlook: "Mobile Phone", "Home Phone 2", "E-mail Address", "E-mail 2 Address", "Web Page".
      const outlookPhone = /^(.*?)\s*(phone|fax)( \d+)?$/.exec(c)
      if (outlookPhone && !c.includes('phonetic') && cell(i)) {
        const where = outlookPhone[1]!.replace('business', 'work').replace('primary', 'main').trim()
        const label = outlookPhone[2] === 'fax' ? [where, 'fax'].filter(Boolean).join(' ') : where || undefined
        phones.push(label ? { value: cell(i), label } : { value: cell(i) })
      } else if (/^e-?mail( \d+)? address$/.test(c) && cell(i)) {
        emails.push({ value: cell(i) })
      } else if (/^(web page|personal web page|business web page)$/.test(c) && cell(i)) {
        const handle = handleFromUrl(cell(i))
        if (handle) handles.push({ value: handle })
        else urls.push({ value: cell(i) })
      }
    })
    // Outlook: an address in parts, as "Home Street", "Home Street 2", "Home City", "Home State",
    // "Home Postal Code", "Home Country/Region", and the same for Business and Other.
    for (const [where, label] of [
      ['home', 'home'],
      ['business', 'work'],
      ['other', 'other'],
    ] as const) {
      const part = (...names: string[]) => cell(col(...names.map((n) => `${where} ${n}`)))
      const street = [part('street'), part('street 2'), part('street 3'), part('address po box')]
        .filter(Boolean)
        .join('\n')
      const address: PersonAddress = { label }
      if (street) address.street = street
      if (part('city')) address.locality = part('city')
      if (part('state')) address.region = part('state')
      if (part('postal code')) address.postcode = part('postal code')
      if (part('country/region', 'country')) address.country = part('country/region', 'country')
      if (Object.keys(address).length > 1) addresses.push(address)
    }
    if (phones.length) card.phones = phones
    if (emails.length) card.emails = emails
    if (handles.length) card.handles = handles
    if (urls.length) card.urls = urls
    if (addresses.length) card.addresses = addresses
    if (!card.name) {
      card.name = [card.prefix, card.given, card.middle, card.family, card.suffix].filter(Boolean).join(' ')
    }
    if (!card.name) card.name = card.org ?? card.nickname ?? emails[0]?.value ?? phones[0]?.value ?? ''
    if (card.name || phones.length || emails.length) cards.push(card)
  }
  return cards
}

/** The cards in an exported contacts file, by what it holds: vCard, or a CSV with a header. */
export function parseContactsFile(text: string): PersonPlaintext[] {
  return /BEGIN:VCARD/i.test(text.slice(0, 4096)) ? parseVCards(text) : parseContactsCsv(text)
}
