// What the sign-in browser sends the server for the person's mouse and keyboard, worked out
// apart from the component so it can be tested. See docs/architecture/signin-browser.md,
// Viewer messages.

export interface Viewport {
  width: number
  height: number
  scale: number
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

type Keys = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** The most a `text` message may carry. */
export const MAX_TEXT = 4096

/**
 * The sign-in browser's socket, on the page's own origin (Caddy, or the dev server, forwards
 * it), with the admission the gateway checks before taking it. The ticket goes as the first
 * message, not in the address, which proxies log.
 */
export function signinSocketUrl(location: { protocol: string; host: string }, admission: string): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/login-browser?admission=${encodeURIComponent(admission)}`
}

/** A frame: the page's generation (four bytes, big-endian), then the JPEG. */
export function parseFrame(data: ArrayBuffer): { gen: number; jpeg: ArrayBuffer } {
  if (data.byteLength < 4) return { gen: 0, jpeg: data }
  return { gen: new DataView(data).getUint32(0), jpeg: data.slice(4) }
}

/** Pointer and keyboard input carries the generation of the frame shown; nothing else needs it. */
export function withGeneration<T extends { type: string }>(message: T, gen: number): T | (T & { gen: number }) {
  return message.type === 'mouse' || message.type === 'key' || message.type === 'text' ? { ...message, gen } : message
}

/** Why the gateway closed the socket before it reached the browser, by close code. */
export const CLOSE_REASONS: Record<number, string> = {
  4401: 'That sign-in page expired. Try again.',
  4409: 'That step of the login is over.',
  4503: 'The server couldn’t open the sign-in page. Try again in a minute.',
}

/**
 * CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. The browser runs on Linux, where
 * shortcuts are on Ctrl, so a Mac's Cmd is sent as Ctrl.
 */
export function modifierBits(e: Keys, mac: boolean): number {
  let bits = 0
  if (e.altKey) bits |= 1
  if (e.ctrlKey || (mac && e.metaKey)) bits |= 2
  if (e.metaKey && !mac) bits |= 4
  if (e.shiftKey) bits |= 8
  return bits
}

/** Where a frame of the viewport's shape is drawn in an area: as large as fits, centred. */
export function frameBox(area: { width: number; height: number }, viewport: Viewport): Box {
  const ratio = Math.min(area.width / viewport.width, area.height / viewport.height)
  const width = viewport.width * ratio
  const height = viewport.height * ratio
  return { x: (area.width - width) / 2, y: (area.height - height) / 2, width, height }
}

/**
 * A point in the drawing area (CSS pixels from its top left) in the page's coordinates, or
 * null when it's off the frame.
 */
export function toViewport(
  point: { x: number; y: number },
  area: { width: number; height: number },
  viewport: Viewport,
): { x: number; y: number } | null {
  const box = frameBox(area, viewport)
  const x = ((point.x - box.x) / box.width) * viewport.width
  const y = ((point.y - box.y) / box.height) * viewport.height
  if (!(x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

const BUTTONS = ['left', 'middle', 'right'] as const

/** DOM's `button` (0 primary, 1 middle, 2 secondary) as CDP names it. */
export const buttonName = (button: number): 'none' | 'left' | 'middle' | 'right' => BUTTONS[button] ?? 'none'

/** Wheel deltas in pixels: a wheel can report lines or pages instead. */
export function wheelPixels(e: { deltaX: number; deltaY: number; deltaMode: number }, pageHeight: number) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1
  return { deltaX: e.deltaX * unit, deltaY: e.deltaY * unit }
}

/**
 * Counts clicks the way a page expects `clickCount`: a press soon after the last one, close to
 * it, is a double (or triple) click.
 */
export function clickCounter(interval = 500, slop = 4) {
  let last: { x: number; y: number; at: number; count: number } | null = null
  return (x: number, y: number, at: number): number => {
    const near = last && at - last.at <= interval && Math.abs(x - last.x) <= slop && Math.abs(y - last.y) <= slop
    const count = near && last ? Math.min(last.count + 1, 3) : 1
    last = { x, y, at, count }
    return count
  }
}

// Windows virtual key codes for the keys that don't type text.
const SPECIAL: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Delete: 46,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
}

// Editing shortcuts passed on as keys. Ctrl+V isn't one: it is left to the paste event, which
// carries the clipboard's text.
const SHORTCUTS = new Set(['a', 'c', 'x', 'z', 'y'])

export interface KeyMessage {
  type: 'key'
  event: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  keyCode: number
  text?: string
  modifiers: number
}

/**
 * The `key` message for a key going down or up, or null for one that types text (sent as `text`
 * from the input it lands in) or isn't passed on. A key with a message is the server's: the
 * caller stops the person's own browser acting on it.
 */
export function keyMessage(
  e: Keys & { key: string; code: string },
  direction: 'down' | 'up',
  mac: boolean,
): KeyMessage | null {
  const modifiers = modifierBits(e, mac)
  const shortcut = (e.ctrlKey || (mac && e.metaKey)) && !e.altKey
  let keyCode = SPECIAL[e.key]
  let key = e.key
  if (keyCode === undefined) {
    const letter = e.key.length === 1 ? e.key.toLowerCase() : ''
    if (!shortcut || !SHORTCUTS.has(letter)) return null
    key = letter
    keyCode = letter.toUpperCase().charCodeAt(0)
  }
  const code = e.code || key
  if (direction === 'up') return { type: 'key', event: 'keyUp', key, code, keyCode, modifiers }
  // Enter goes down with its text, which is what submits a form.
  if (key === 'Enter' && !shortcut) return { type: 'key', event: 'keyDown', key, code, keyCode, text: '\r', modifiers }
  return { type: 'key', event: 'rawKeyDown', key, code, keyCode, modifiers }
}

interface ImeKey {
  isComposing: boolean
  keyCode: number
  code: string
  repeat: boolean
}

// Browsers mark an IME's keys composing, or (Safari, for the key that ends one) with the key
// code 229.
const composing = (e: ImeKey) => e.isComposing || e.keyCode === 229

/**
 * Tracks the keys an IME owns, which stay with the person's own browser: Enter there picks a
 * candidate and the arrows move through them. A press that went down to the IME stays its own
 * while held and when released, even once the composition has ended.
 */
export function imeKeys() {
  const owned = new Set<string>()
  return {
    /** Whether a key going down is the IME's. */
    down(e: ImeKey): boolean {
      if (composing(e)) {
        owned.add(e.code)
        return true
      }
      if (!owned.has(e.code)) return false
      if (e.repeat) return true
      // A fresh press: the last one's release went elsewhere (focus moved, say).
      owned.delete(e.code)
      return false
    },
    /** Whether a key coming up is the IME's. */
    up(e: ImeKey): boolean {
      return owned.delete(e.code) || composing(e)
    },
  }
}

/** A `page` message's address, as the person reads it: the host, without `www.`. */
export function pageHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}
