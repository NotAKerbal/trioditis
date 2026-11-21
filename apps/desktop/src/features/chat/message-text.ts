// How a message's text is laid out in the list: which messages run together, where the time
// goes, which text is links, and which is a few emoji shown large.

/** Messages this close together share a time: one label above them, not one per bubble. */
const TIME_GAP_MS = 15 * 60_000

interface Placed {
  self: boolean
  ghostId: string | undefined
  at: number
}

/** Whether `b`, the message after `a`, comes soon enough after it, on the same day, to share its time. */
export function sameTime(a: Placed | undefined, b: Placed | undefined): boolean {
  if (!a || !b) return false
  if (Math.abs(b.at - a.at) >= TIME_GAP_MS) return false
  return new Date(a.at).toDateString() === new Date(b.at).toDateString()
}

/** Whether `b` joins `a`'s bubbles: the same sender, around the same time. */
export function sameRun(a: Placed | undefined, b: Placed | undefined): boolean {
  if (!a || !b || a.self !== b.self || a.ghostId !== b.ghostId) return false
  return sameTime(a, b)
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

// A web address runs to the next space. What ends it is trimmed off below: punctuation after
// it, and a closing bracket it didn't open, so "(see https://x.test/a_(b))." links "…a_(b)".
const CANDIDATE = /\bhttps?:\/\/[^\s<>"]+/gi
const TRAILING = new Set(['.', ',', ':', ';', '!', '?', "'", '"'])
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

const count = (s: string, c: string) => s.split(c).length - 1

function trimLink(candidate: string): string {
  let url = candidate
  for (;;) {
    const last = url.at(-1)!
    const opener = CLOSERS[last]
    if (TRAILING.has(last) || (opener && count(url, last) > count(url, opener))) url = url.slice(0, -1)
    else return url
  }
}

/** A link only for an address the browser reads as http or https: nothing else gets an anchor. */
function webLink(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** The text split into plain runs and web links, in order. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0
  const push = (piece: string) => {
    const prev = parts.at(-1)
    if (prev?.kind === 'text') prev.text += piece
    else if (piece) parts.push({ kind: 'text', text: piece })
  }
  for (const match of text.matchAll(CANDIDATE)) {
    const url = trimLink(match[0])
    const href = webLink(url)
    push(text.slice(at, match.index))
    if (href) parts.push({ kind: 'link', text: url, href })
    else push(url)
    at = match.index + url.length
  }
  push(text.slice(at))
  return parts
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// An emoji has a picture, a flag's letters or a keycap; around it, skin tones, joiners,
// variation selectors and a subdivision flag's tags.
const EMOJI_MARK = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u
const EMOJI_PARTS =
  /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\u20e3|[\u{e0020}-\u{e007f}]/gu

function isEmoji(grapheme: string): boolean {
  if (!EMOJI_MARK.test(grapheme)) return false
  const rest = grapheme.replace(EMOJI_PARTS, '')
  // A keycap is a digit, # or * with its combining mark, as in the emoji for 1.
  return rest === '' || (grapheme.includes('\u20e3') && /^[#*0-9]$/.test(rest))
}

/** One to three emoji and nothing else, which messaging apps show large and without a bubble. */
export function isBigEmoji(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 64) return false
  const shown = [...graphemes.segment(t)].map((s) => s.segment).filter((g) => g.trim())
  return shown.length > 0 && shown.length <= 3 && shown.every(isEmoji)
}
