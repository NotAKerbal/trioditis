import { api } from '@trioditis/backend/api'
import type { Attachment, Network } from '@trioditis/core'
import { decryptMedia } from '@trioditis/crypto'
import { useEffect, useState } from 'react'
import { convex } from '~/lib/convex.ts'
import { useSession } from '~/lib/session.tsx'

// People's pictures and files (docs/architecture/client-api.md, Media). The gateway passes along
// a file's ciphertext from the bridge host that has it, for a media token Convex signs; the key is
// in the sealed message, so the file is decrypted only here, and kept only in memory, as an
// object URL.

/** Pictures shown in place; any other picture (SVG among them) is a file to save. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
/** Pictures larger than this wait to be asked for, as other files do. */
const AUTO_LOAD_BYTES = 25 * 1024 * 1024
/** Decrypted files kept, by total size, before the oldest are let go. */
const KEPT_BYTES = 200 * 1024 * 1024
/** Files fetched at once: a chat full of pictures loads a few at a time. */
const CONCURRENT = 6
/** A token is renewed this long before it runs out, so a fetch never starts with a stale one. */
const TOKEN_MARGIN_MS = 5 * 60_000

export const isImage = (a: Attachment) => IMAGE_TYPES.has(a.mime.toLowerCase())
export const isVideo = (a: Attachment) => /^video\/[a-z0-9.+-]+$/.test(a.mime.toLowerCase())
export const isAudio = (a: Attachment) => /^audio\/[a-z0-9.+-]+$/.test(a.mime.toLowerCase())
export const loadsByItself = (a: Attachment) => isImage(a) && a.size <= AUTO_LOAD_BYTES

/**
 * The type a decrypted file is given. Pictures, video and sound keep theirs, which never run
 * anything; anything else is a plain download, so a file that says it's a page (or an SVG) can
 * never open as one on the app's own origin.
 */
function shownType(a: Attachment) {
  return isImage(a) || isVideo(a) || isAudio(a) ? a.mime.toLowerCase() : 'application/octet-stream'
}

type Token = { token: string; expiresAt: number }
const tokens = new Map<string, Promise<Token>>()

function tokenFor(userId: string, network: Network, fresh = false): Promise<Token> {
  const key = `${userId}/${network}`
  const held = tokens.get(key)
  if (held && !fresh) {
    // A held token is used until it nears its end; a failed request for one is asked again.
    return held.then((t) => (t.expiresAt - Date.now() > TOKEN_MARGIN_MS ? t : tokenFor(userId, network, true)))
  }
  const asked = convex.mutation(api.media.access, { network })
  tokens.set(key, asked)
  asked.catch(() => tokens.get(key) === asked && tokens.delete(key))
  return asked
}

let running = 0
const waiting: (() => void)[] = []
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  running++
  try {
    return await work()
  } finally {
    running--
    waiting.shift()?.()
  }
}

async function fetchCiphertext(userId: string, network: Network, mediaId: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    const { token } = await tokenFor(userId, network, attempt > 0)
    const response = await fetch(`/media/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    // A token the gateway no longer takes is asked for again; a busy gateway, waited for.
    const again = response.status === 401 || response.status === 503
    if (!again || attempt >= 2) throw new Error(`The file couldn’t be fetched (${response.status}).`)
    if (response.status === 503) await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
}

interface Kept {
  url: Promise<string>
  size: number
}
// Oldest first, by insertion; a file used again moves to the end.
const kept = new Map<string, Kept>()
let keptBytes = 0

function keep(key: string, entry: Kept) {
  kept.set(key, entry)
  keptBytes += entry.size
  for (const [oldKey, old] of kept) {
    if (keptBytes <= KEPT_BYTES || oldKey === key) break
    kept.delete(oldKey)
    keptBytes -= old.size
    void old.url.then(
      (url) => URL.revokeObjectURL(url),
      () => {},
    )
  }
}

/** An object URL for a file, decrypted (with its shownType). */
export function mediaUrl(userId: string, network: Network, attachment: Attachment): Promise<string> {
  const key = `${userId}/${attachment.mediaId}`
  const held = kept.get(key)
  if (held) {
    kept.delete(key)
    kept.set(key, held)
    return held.url
  }
  const url = inTurn(async () => {
    const ciphertext = await fetchCiphertext(userId, network, attachment.mediaId)
    const bytes = decryptMedia(ciphertext, attachment.key, attachment.nonce, userId, attachment.mediaId)
    return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: shownType(attachment) }))
  })
  const entry = { url, size: attachment.size || 0 }
  keep(key, entry)
  // A failure isn't kept, so the file is tried again the next time it's shown.
  url.catch(() => {
    if (kept.get(key) !== entry) return
    kept.delete(key)
    keptBytes -= entry.size
  })
  return url
}

export type MediaState = { state: 'idle' | 'loading' | 'failed'; url?: undefined } | { state: 'ready'; url: string }

/**
 * A file's object URL once it's decrypted. It loads by itself when `auto` (the default: small
 * pictures), or after `load()` is called, which also tries again after a failure.
 */
export function useMedia(
  network: Network,
  attachment: Attachment | undefined,
  auto = attachment ? loadsByItself(attachment) : false,
): MediaState & { load: () => void } {
  const session = useSession()
  const [asked, setAsked] = useState(0)
  const [state, setState] = useState<MediaState>({ state: 'idle' })
  const mediaId = attachment?.mediaId
  const wanted = !!attachment && (auto || asked > 0)
  useEffect(() => {
    if (!attachment || !wanted) return setState({ state: 'idle' })
    let current = true
    setState({ state: 'loading' })
    mediaUrl(session.userId, network, attachment).then(
      (url) => current && setState({ state: 'ready', url }),
      () => current && setState({ state: 'failed' }),
    )
    return () => {
      current = false
    }
    // The attachment is the same file for as long as its media ID is.
  }, [session.userId, network, mediaId, wanted, asked])
  return { ...state, load: () => setAsked((n) => n + 1) }
}
