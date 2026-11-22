import type { Attachment, LinkPreview, MessagePlaintext } from '@trioditis/core'
import { linkParts, trimLink } from './message-text.ts'

// Which cards a message shows for its links. A network's own preview (made on the sender's
// device, sealed in the message) is shown as it came. A link without one gets a card drawn from
// its address alone: nothing here fetches the page, so opening a chat tells no site it was read.

/** A card for a link, from the network's preview or from the address alone. */
export type LinkCard =
  | {
      kind: 'preview'
      href: string
      host: string
      title?: string
      description?: string
      siteName?: string
      image?: Attachment
    }
  | {
      kind: 'address'
      href: string
      host: string
      service: Service
      /** What the address says the page is: "Presentation", "owner/repo", the page's path. */
      detail?: string
    }

/** What a link's address alone says about where it goes. */
export interface Service {
  /** The name shown as the card's title when the page's own isn't known. */
  name: string
  icon: ServiceIcon
  tone: ServiceTone
}
export type ServiceIcon = 'slides' | 'doc' | 'sheet' | 'form' | 'drive' | 'video' | 'code' | 'map' | 'web'
export type ServiceTone = 'amber' | 'blue' | 'green' | 'violet' | 'pink' | 'slate'

/** How many network previews one message shows; the bridge host sends no more than three. */
const MAX_PREVIEWS = 3

/** A web address as the browser reads it, or null for anything that isn't http or https. */
export function webURL(href: unknown): URL | null {
  if (typeof href !== 'string' || href.length > 2048) return null
  try {
    const url = new URL(href)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/**
 * The host a card shows: the whole of it, as the browser reads it, never shortened, so a
 * card always says exactly where it opens.
 */
export function shownHost(url: URL): string {
  return url.hostname
}

const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/**
 * A network's preview, checked: the sealed message is the bridge host's word, and a client
 * opens only a web address.
 */
function fromNetwork(p: LinkPreview, written: Set<string>): LinkCard | null {
  if (!p || typeof p !== 'object') return null
  const url = webURL(p.url)
  // A card opens only a link the message itself has: a preview can't bring in a destination
  // of its own (a "Bank sign-in" card for somewhere else under a message linking the bank).
  if (!url || !written.has(url.href)) return null
  // Whether it's a picture this app draws is up to the card (data/media.ts, isImage).
  const image =
    p.image &&
    typeof p.image === 'object' &&
    !p.image.failed &&
    typeof p.image.mediaId === 'string' &&
    typeof p.image.mime === 'string'
      ? p.image
      : undefined
  const card: LinkCard = {
    kind: 'preview',
    href: url.href,
    host: shownHost(url),
    title: text(p.title, 300),
    description: text(p.description, 600),
    siteName: text(p.siteName, 100),
    image,
  }
  return card.title || card.description || card.image ? card : null
}

const GOOGLE_DOCS: Record<string, Service & { detail: string }> = {
  presentation: { name: 'Google Slides', icon: 'slides', tone: 'amber', detail: 'Presentation' },
  document: { name: 'Google Docs', icon: 'doc', tone: 'blue', detail: 'Document' },
  spreadsheets: { name: 'Google Sheets', icon: 'sheet', tone: 'green', detail: 'Spreadsheet' },
  forms: { name: 'Google Forms', icon: 'form', tone: 'violet', detail: 'Form' },
  drawings: { name: 'Google Drawings', icon: 'doc', tone: 'pink', detail: 'Drawing' },
}

/** A path segment made readable: "my-trip_notes.pdf" says "my trip notes.pdf". */
function readable(segment: string): string {
  let s = segment
  try {
    s = decodeURIComponent(segment)
  } catch {
    // Left as written when it isn't valid percent-encoding.
  }
  return s.replace(/[-_+]+/g, ' ').trim()
}

/** What a link's address alone says: the service it's on and what it is there, when known. */
export function fromAddress(url: URL): { service: Service; detail?: string } {
  // Matched without `www.`, which the services answer to either way.
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.split('/').filter(Boolean)
  const web: Service = { name: shownHost(url), icon: 'web', tone: 'slate' }

  if (host === 'docs.google.com') {
    // docs.google.com/presentation/d/<id>/edit, and /u/1/presentation/... for a second account.
    // Own keys only: a path segment such as "constructor" must not find an inherited property.
    const kind = path.find((p) => Object.hasOwn(GOOGLE_DOCS, p))
    const known = kind ? GOOGLE_DOCS[kind] : undefined
    if (known) return { service: known, detail: known.detail }
  }
  if (host === 'drive.google.com') {
    const folder = path.includes('folders')
    return { service: { name: 'Google Drive', icon: 'drive', tone: 'green' }, detail: folder ? 'Folder' : 'File' }
  }
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const short = path[0] === 'shorts'
    return {
      service: { name: host === 'music.youtube.com' ? 'YouTube Music' : 'YouTube', icon: 'video', tone: 'pink' },
      detail: short ? 'Short' : path[0] === 'playlist' ? 'Playlist' : 'Video',
    }
  }
  if (host === 'github.com' && path.length >= 2) {
    const repo = `${path[0]}/${path[1]}`
    const number = path[3] && /^\d+$/.test(path[3]) ? path[3] : undefined
    const detail =
      path[2] === 'pull' && number
        ? `${repo} · Pull request #${number}`
        : path[2] === 'issues' && number
          ? `${repo} · Issue #${number}`
          : repo
    return { service: { name: 'GitHub', icon: 'code', tone: 'slate' }, detail }
  }
  if ((host === 'google.com' || host.endsWith('.google.com')) && path[0] === 'maps') {
    return { service: { name: 'Google Maps', icon: 'map', tone: 'green' }, detail: 'Map' }
  }
  if (host === 'maps.app.goo.gl' || host === 'maps.google.com') {
    return { service: { name: 'Google Maps', icon: 'map', tone: 'green' }, detail: 'Map' }
  }
  // Anywhere else, the last part of the path says most about the page.
  const last = path.at(-1)
  return { service: web, detail: last ? readable(last).slice(0, 120) || undefined : undefined }
}

// What may come before and after a link written without its scheme: a space, a bracket or
// quote around it, or punctuation after it.
const OPENERS = /^[("'[<{]+/

/**
 * The web addresses the text links to, as the browser writes them: its http and https links,
 * and the words that read as a site with no scheme ("example.com/a"), which networks preview
 * too. A word only counts as one when its host is names with dots ending in letters (so "1.5"
 * isn't), and nothing a host can't have.
 */
export function writtenLinks(text: string): Set<string> {
  const links = new Set<string>()
  for (const part of linkParts(text)) {
    const url = part.kind === 'link' ? webURL(part.href) : null
    if (url) links.add(url.href)
  }
  for (const word of text.split(/\s+/)) {
    // A word with no dot is no site, and one longer than any address isn't one either.
    if (!word.includes('.') || word.length > 2048) continue
    // Trimmed as a link with its scheme is (message-text.ts), so a closing bracket the link
    // opened stays: "example.com/archive_(2026)" is the whole of it.
    const opened = word.replace(OPENERS, '')
    const bare = opened && trimLink(opened)
    if (!bare || /^[a-z][a-z0-9+.-]*:/i.test(bare) || bare.includes('@')) continue
    const host = bare.split(/[/?#]/)[0]!
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)) continue
    const url = webURL(`https://${bare}`)
    if (url) links.add(url.href)
  }
  return links
}

/**
 * The cards a message shows under its text: the network's previews when it sent any, otherwise
 * one card for the first web link in the text (as iMessage does, so a message of many links
 * doesn't become a wall of cards).
 */
export function linkCards(message: MessagePlaintext, text: string): LinkCard[] {
  const previews = Array.isArray(message.previews) ? message.previews : []
  const written = writtenLinks(text)
  const cards = previews
    .map((p) => fromNetwork(p, written))
    .filter((c): c is LinkCard => c !== null)
    .slice(0, MAX_PREVIEWS)
  if (cards.length) return cards
  const first = linkParts(text).find((p) => p.kind === 'link')
  const url = first?.kind === 'link' ? webURL(first.href) : null
  if (!url) return []
  return [{ kind: 'address', href: url.href, host: shownHost(url), ...fromAddress(url) }]
}

/**
 * Whether the text is nothing but the link a card shows, so the card can stand in for it.
 * Only for a network's preview, whose card says the page's title; an address card is drawn
 * from the address, so the address stays.
 */
export function cardReplacesText(cards: LinkCard[], text: string): boolean {
  const [card] = cards
  if (cards.length !== 1 || card?.kind !== 'preview') return false
  const [part, ...rest] = linkParts(text.trim())
  if (rest.length || part?.kind !== 'link') return false
  const said = webURL(part.href)
  // The very same destination, as the browser writes it: anything else (the page's canonical
  // address without the section it pointed to, or with a slash the server may not serve) would
  // hide where the sent link went.
  return said !== null && said.href === new URL(card.href).href
}
