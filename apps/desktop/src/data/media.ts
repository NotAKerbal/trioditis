import { api } from '@trioditis/backend/api'
import type { Attachment, MessageType, Network } from '@trioditis/core'
import { decryptMedia, encryptMedia, toBase64Url } from '@trioditis/crypto'
import { useEffect, useRef, useState } from 'react'
import { retryDelay } from '~/features/shell/retry-delay.ts'
import { convex } from '~/lib/convex.ts'
import { isTransient } from '~/lib/resilient-convex.ts'
import { useSession } from '~/lib/session.tsx'

// People's pictures and files (docs/architecture/client-api.md, Media). The gateway passes along
// a file's ciphertext from the bridge host that has it, for a media token Convex signs; the key is
// in the sealed message, so the file is decrypted only here. What is shown is kept as a data: URL,
// in memory: never a Blob, which the browser may page to disk. Only a file the person saves
// becomes one, on its way to their downloads.

/** Pictures shown in place; any other picture (SVG among them) is a file to save. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])
/** Pictures larger than this wait to be asked for, as other files do. */
const AUTO_LOAD_BYTES = 25 * 1024 * 1024
/** Video and sound larger than this can only be saved, not played here. */
const PLAYABLE_BYTES = 50 * 1024 * 1024
/** The largest file that can be sent: what the gateway and bridge host take, less the tag. */
export const MAX_SEND_BYTES = 100 * 1024 * 1024
/** Decrypted files kept, by total size, before the oldest are let go. */
const KEPT_BYTES = 200 * 1024 * 1024
/** After a picture fails by itself, it's tried again after these waits. */
const RETRY_MS = [3_000, 10_000, 30_000, 60_000, 120_000]
/** Files fetched at once: a chat full of pictures loads a few at a time. */
const CONCURRENT = 6
/** A token is renewed this long before it runs out, so a fetch never starts with a stale one. */
const TOKEN_MARGIN_MS = 5 * 60_000

export const isImage = (a: Attachment) => IMAGE_TYPES.has(a.mime.toLowerCase())
export const isVideo = (a: Attachment) => /^video\/[a-z0-9.+-]+$/.test(a.mime.toLowerCase())
export const isAudio = (a: Attachment) => /^audio\/[a-z0-9.+-]+$/.test(a.mime.toLowerCase())
export const loadsByItself = (a: Attachment) => isImage(a) && a.size <= AUTO_LOAD_BYTES
export const playable = (a: Attachment) => (isVideo(a) || isAudio(a)) && a.size <= PLAYABLE_BYTES

/**
 * The server too busy to give a file now (a media token timed out, the gateway answered 502–504):
 * the picture keeps loading and is tried again, rather than showing as broken.
 */
export class ServerBusy extends Error {}

type Token = { token: string; expiresAt: number }
const tokens = new Map<string, Promise<Token>>()
/** Token requests in a row that the server failed to answer, by network, for the wait before the next. */
const tokenFailures = new Map<string, number>()

/**
 * A media token for this network: the one held while it lasts, else a new one. `stale` is a token
 * the gateway refused (401): it's replaced, but once only, however many files were refused it.
 */
function tokenFor(userId: string, network: Network, stale?: string): Promise<Token> {
  const key = `${userId}/${network}`
  const held = tokens.get(key)
  if (!held) return askToken(key, network)
  // A failed request for one is shared while it cools down (askToken), then asked again.
  return held.then((t) => {
    if (t.token !== stale && t.expiresAt - Date.now() > TOKEN_MARGIN_MS) return t
    const now = tokens.get(key)
    return now && now !== held ? now : askToken(key, network)
  })
}

function askToken(key: string, network: Network): Promise<Token> {
  const asked = convex.mutation(api.media.access, { network }).catch((error: unknown) => {
    throw isTransient(error) ? new ServerBusy('The server is busy.') : error
  })
  tokens.set(key, asked)
  asked.then(
    () => tokenFailures.delete(key),
    (error: unknown) => {
      if (!(error instanceof ServerBusy)) return tokens.get(key) === asked && tokens.delete(key)
      // Every picture waiting on this token shares the failure for a while, so a chat full of
      // them asks a busy server once, not once each, and less often while it stays busy.
      const failures = (tokenFailures.get(key) ?? 0) + 1
      tokenFailures.set(key, failures)
      setTimeout(() => tokens.get(key) === asked && tokens.delete(key), retryDelay(failures))
    },
  )
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

/** Exported for its tests. */
export async function fetchCiphertext(userId: string, network: Network, mediaId: string): Promise<Uint8Array> {
  let { token } = await tokenFor(userId, network)
  for (let attempt = 0; ; attempt++) {
    // Each fetch goes through the gateway's checks, never the browser's cache.
    const response = await fetch(`/media/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (response.ok) return new Uint8Array(await response.arrayBuffer())
    const busy = response.status >= 502 && response.status <= 504
    if (attempt >= 2 || (!busy && response.status !== 401)) {
      if (busy) throw new ServerBusy('The server is busy.')
      throw new Error(`The file couldn’t be fetched (${response.status}).`)
    }
    // A token the gateway no longer takes is replaced; a busy gateway is waited for, with the
    // same token, which it took: asking for another would only add to what keeps it busy.
    if (response.status === 401) ({ token } = await tokenFor(userId, network, token))
    else await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
}

function decrypted(userId: string, network: Network, attachment: Attachment): Promise<Uint8Array> {
  return inTurn(async () => {
    const ciphertext = await fetchCiphertext(userId, network, attachment.mediaId)
    return decryptMedia(ciphertext, attachment.key, attachment.nonce, userId, attachment.mediaId)
  })
}

function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (native) return native.call(bytes)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

interface Kept {
  url: Promise<string>
  /** The URL once it's ready, so a picture shown before is drawn at once, not after a frame of initials. */
  ready?: string
  size: number
}
// Oldest first, by insertion; a file used again moves to the end. A data: URL let go here stays
// valid wherever it's still shown, so nothing on screen breaks.
const kept = new Map<string, Kept>()
let keptBytes = 0

function keep(key: string, entry: Kept) {
  kept.set(key, entry)
  keptBytes += entry.size
  for (const [oldKey, old] of kept) {
    if (keptBytes <= KEPT_BYTES || oldKey === key) break
    kept.delete(oldKey)
    keptBytes -= old.size
  }
}

/**
 * A data: URL for a picture, video or sound, decrypted. Only those types are given: they never
 * run anything, where a file that says it's a page (or an SVG) could on the app's own origin.
 */
export function mediaUrl(userId: string, network: Network, attachment: Attachment): Promise<string> {
  if (!isImage(attachment) && !playable(attachment)) return Promise.reject(new Error('Not shown here.'))
  const key = `${userId}/${attachment.mediaId}`
  const held = kept.get(key)
  if (held) {
    kept.delete(key)
    kept.set(key, held)
    return held.url
  }
  const entry: Kept = { url: Promise.resolve(''), size: attachment.size || 0 }
  const url = decrypted(userId, network, attachment).then((bytes) => {
    const ready = `data:${attachment.mime.toLowerCase()};base64,${base64(bytes)}`
    entry.ready = ready
    return ready
  })
  entry.url = url
  keep(key, entry)
  // A failure isn't kept, so the file is tried again the next time it's shown.
  url.catch(() => {
    if (kept.get(key) !== entry) return
    kept.delete(key)
    keptBytes -= entry.size
  })
  return url
}

/** A file's data: URL if it's decrypted and kept already, without waiting; else undefined. */
export function readyMediaUrl(userId: string, attachment: Attachment | undefined): string | undefined {
  return attachment ? kept.get(`${userId}/${attachment.mediaId}`)?.ready : undefined
}

/**
 * Saves a file to the person's downloads under its own name. It is the one time a decrypted file
 * becomes a Blob, as a plain download, so it can never open as a page here.
 */
export async function saveMedia(userId: string, network: Network, attachment: Attachment, name: string) {
  if (attachment.failed) throw new Error('This file wasn’t kept.')
  const bytes = await decrypted(userId, network, attachment)
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  // Long enough for the download to start.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export type MediaState = { state: 'idle' | 'loading' | 'failed'; url?: undefined } | { state: 'ready'; url: string }

/**
 * A picture's, video's or sound's data: URL once it's decrypted. It loads by itself when `auto`
 * (the default: small pictures), trying again a few times if it fails, or after `load()` is
 * called, which also tries again after a failure. While `active` is false (a picture far
 * offscreen), it holds nothing, so the URL can be let go.
 */
export function useMedia(
  network: Network,
  attachment: Attachment | undefined,
  auto = attachment ? loadsByItself(attachment) : false,
  active = true,
): MediaState & { load: () => void } {
  const session = useSession()
  const [asked, setAsked] = useState(0)
  const [state, setState] = useState<MediaState & { mediaId?: string }>({ state: 'idle' })
  const retries = useRef({ mediaId: '', count: 0 })
  const mediaId = attachment?.mediaId
  // A file the bridge host couldn't store has nothing to fetch (`failed` on Attachment).
  const wanted = !!attachment && !attachment.failed && active && (auto || asked > 0)
  useEffect(() => {
    if (!attachment || !wanted) return setState({ state: 'idle' })
    let current = true
    let retry: ReturnType<typeof setTimeout> | undefined
    if (retries.current.mediaId !== attachment.mediaId) retries.current = { mediaId: attachment.mediaId, count: 0 }
    setState({ state: 'loading', mediaId: attachment.mediaId })
    mediaUrl(session.userId, network, attachment).then(
      (url) => current && setState({ state: 'ready', url, mediaId: attachment.mediaId }),
      (error: unknown) => {
        if (!current) return
        // A busy server isn't a broken picture: it stays loading, and is tried again for as long
        // as it's shown, waiting longer while the server stays busy.
        if (error instanceof ServerBusy) {
          retries.current.count++
          retry = setTimeout(() => setAsked((n) => n + 1), retryDelay(retries.current.count))
          return
        }
        setState({ state: 'failed', mediaId: attachment.mediaId })
        // A bridge host restarting fails a picture for a moment; one that loads by itself
        // shouldn't stay broken for it.
        const wait = auto ? RETRY_MS[retries.current.count] : undefined
        if (wait !== undefined) {
          retries.current.count++
          retry = setTimeout(() => setAsked((n) => n + 1), wait)
        }
      },
    )
    return () => {
      current = false
      clearTimeout(retry)
    }
    // The attachment is the same file for as long as its media ID is.
  }, [session.userId, network, mediaId, wanted, asked])
  // A file decrypted already shows at once, before the effect has run; until the effect catches
  // up with another file, nothing of the last one is shown.
  const ready = wanted ? readyMediaUrl(session.userId, attachment) : undefined
  const shown: MediaState = ready
    ? { state: 'ready', url: ready }
    : state.mediaId === mediaId
      ? state
      : { state: wanted ? 'loading' : 'idle' }
  return { ...shown, load: () => setAsked((n) => n + 1) } as MediaState & { load: () => void }
}

// Sending: a file is encrypted here with its own key, as received ones are, and its ciphertext
// given to the gateway (PUT /media/<mediaId>) for the bridge host that will send it, under an
// upload token Convex signs for the chat. The key goes only in the sealed send that follows.

const uploadTokens = new Map<string, Promise<Token>>()

function uploadTokenFor(chatId: string, stale?: string): Promise<Token> {
  const held = uploadTokens.get(chatId)
  const ask = () => {
    const asked = convex.mutation(api.media.upload, { chatId: chatId as never }).catch((error: unknown) => {
      if (uploadTokens.get(chatId) === asked) uploadTokens.delete(chatId)
      throw isTransient(error) ? new ServerBusy('The server is busy.') : error
    })
    uploadTokens.set(chatId, asked)
    return asked
  }
  if (!held) return ask()
  return held.then(
    (t) => (t.token !== stale && t.expiresAt - Date.now() > TOKEN_MARGIN_MS ? t : ask()),
    () => ask(),
  )
}

/** What kind of message a file goes as. */
export function messageTypeOf(mime: string): MessageType {
  const type = mime.toLowerCase()
  if (IMAGE_TYPES.has(type)) return 'image'
  if (/^video\/[a-z0-9.+-]+$/.test(type)) return 'video'
  if (/^audio\/[a-z0-9.+-]+$/.test(type)) return 'audio'
  return 'file'
}

/** A picture's size in pixels, for the network to lay it out before it loads; none if it won't decode. */
async function dimensions(file: Blob): Promise<{ width?: number; height?: number }> {
  if (typeof createImageBitmap !== 'function') return {}
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return {}
  }
}

/**
 * Encrypts a file and gives its ciphertext to the bridge host that runs `chatId`'s account,
 * returning the attachment for its sealed send.
 */
export async function uploadFile(userId: string, chatId: string, file: File): Promise<Attachment> {
  if (file.size > MAX_SEND_BYTES) throw new Error(`${file.name || 'That file'} is over 100 MB.`)
  const mime = file.type || 'application/octet-stream'
  const bytes = new Uint8Array(await file.arrayBuffer())
  const mediaId = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const { ciphertext, key, nonce } = encryptMedia(bytes, userId, mediaId)
  let { token } = await uploadTokenFor(chatId)
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`/media/${encodeURIComponent(mediaId)}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: ciphertext as Uint8Array<ArrayBuffer>,
      cache: 'no-store',
    })
    // The ID is 128 random bits made here, so after a try whose answer was lost, finding it in
    // use means that try kept it.
    if (response.status === 201 || (response.status === 409 && attempt > 0)) break
    if (response.status === 413) throw new Error(`${file.name || 'That file'} is too large to send.`)
    const busy = response.status >= 502 && response.status <= 504
    if (attempt >= 2 || (!busy && response.status !== 401)) {
      if (busy) throw new ServerBusy('The server is busy.')
      throw new Error(`The file couldn’t be sent (${response.status}).`)
    }
    // A put is never half-kept: the same ID is either all there (201) or not at all, so trying
    // again with it is safe.
    if (response.status === 401) ({ token } = await uploadTokenFor(chatId, token))
    else await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)))
  }
  const type = messageTypeOf(mime)
  const attachment: Attachment = {
    mediaId,
    mime,
    size: file.size,
    ...(file.name ? { name: file.name } : {}),
    key,
    nonce,
    ...(type === 'image' ? await dimensions(file) : {}),
  }
  // The sender's own picture shows at once, from what they picked, rather than fetched back.
  if (loadsByItself(attachment)) {
    const ready = `data:${mime.toLowerCase()};base64,${base64(bytes)}`
    keep(`${userId}/${mediaId}`, { url: Promise.resolve(ready), ready, size: file.size })
  }
  return attachment
}
