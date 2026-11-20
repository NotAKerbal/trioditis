// How a message's text is laid out in the list: which messages run together, which text is
// links, and which is a few emoji shown large.

/** Messages from one sender this close together, on one day, share a run of joined bubbles. */
const RUN_GAP_MS = 10 * 60_000

interface Placed {
  self: boolean
  ghostId: string | undefined
  at: number
}

export function sameRun(a: Placed | undefined, b: Placed | undefined): boolean {
  if (!a || !b) return false
  if (a.self !== b.self || a.ghostId !== b.ghostId) return false
  if (Math.abs(b.at - a.at) >= RUN_GAP_MS) return false
  return new Date(a.at).toDateString() === new Date(b.at).toDateString()
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; href: string }

// Web links only: a scheme people can't click by accident into something else. Trailing
// punctuation stays text, so "see https://example.com." doesn't link the full stop.
const LINK = /\bhttps?:\/\/[^\s<>"]*[^\s<>".,:;!?'")\]}]/gi

/** The text split into plain runs and web links, in order. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0
  for (const match of text.matchAll(LINK)) {
    const start = match.index
    if (start > at) parts.push({ kind: 'text', text: text.slice(at, start) })
    parts.push({ kind: 'link', text: match[0], href: match[0] })
    at = start + match[0].length
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) })
  return parts
}

const PICTOGRAPH = /\p{Extended_Pictographic}/gu
// What may sit between emoji: skin tones, joiners, variation selectors and spaces.
const JOINERS = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3|\s/gu

/** One to three emoji and nothing else, which messaging apps show large and without a bubble. */
export function isBigEmoji(text: string): boolean {
  const t = text.trim()
  if (!t || t.length > 40) return false
  const count = t.match(PICTOGRAPH)?.length ?? 0
  return count > 0 && count <= 3 && t.replace(JOINERS, '') === ''
}
