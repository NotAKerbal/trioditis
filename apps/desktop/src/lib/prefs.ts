import { useSyncExternalStore } from 'react'

// This device's display preferences: they live in this browser only. The sidebar layout follows
// the person across devices, so it is stored on the server instead (data/preferences.ts).

export type Theme = 'system' | 'light' | 'dark'

/**
 * What a notification shows: the sender and the message unless the person chooses less. The
 * system can keep notifications in its history, outside the sealing (AGENTS.md).
 */
export type NotificationDetail = 'hidden' | 'sender' | 'message'

export interface Prefs {
  theme: Theme
  previews: boolean
  networkBadges: boolean
  /** Notify for new messages, once the browser allows it. */
  notifications: boolean
  notificationDetail: NotificationDetail
}

const DEFAULTS: Prefs = {
  theme: 'system',
  previews: true,
  networkBadges: true,
  notifications: true,
  notificationDetail: 'message',
}
const KEY = 'trioditis.prefs'
const DETAILS: NotificationDetail[] = ['hidden', 'sender', 'message']

/** What's stored, as it is now; null if storage can't be read or holds something unreadable. */
function readSaved(): Record<string, unknown> | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function fromSaved(saved: Record<string, unknown>): Prefs {
  // Only today's preferences: one that's gone (notificationContent, say) isn't kept or saved.
  const known = Object.fromEntries(Object.entries(saved).filter(([key]) => Object.hasOwn(DEFAULTS, key)))
  const loaded = { ...DEFAULTS, ...known } as Prefs
  // A value this version doesn't know shows the least, never more than was chosen.
  if (!DETAILS.includes(loaded.notificationDetail)) loaded.notificationDetail = 'hidden'
  return loaded
}

/**
 * Choices made here that storage refused to save, laid over what's stored until a save goes
 * through: reading storage again mustn't bring back what the person just changed.
 */
let unsaved: Partial<Prefs> = {}

/** The stored preferences, with this tab's unsaved choices; null when storage can't say. */
function load(): Prefs | null {
  const saved = readSaved()
  return saved ? { ...fromSaved(saved), ...unsaved } : null
}

let prefs = load() ?? DEFAULTS
const listeners = new Set<() => void>()

/**
 * Reads the preferences again from storage, for a change another tab made: each tab keeps its
 * own copy, and one left stale would go on showing what the person turned off elsewhere.
 */
function reload() {
  const next = load()
  // Storage that can't be read says nothing: an opt-out held here is never undone by defaults.
  if (!next || JSON.stringify(next) === JSON.stringify(prefs)) return
  prefs = next
  applyTheme()
  listeners.forEach((l) => l())
}

/**
 * The preferences as stored now, for a decision that can't wait for another tab's change to
 * arrive, such as whether to show a notification and what it says.
 */
export function currentPrefs(): Prefs {
  reload()
  return prefs
}

/**
 * Changes one preference. It's laid over what's stored now, not this tab's copy, which may be
 * stale: another tab's change a moment ago (notifications turned off, say) is kept, never
 * written back over with what this tab last heard.
 */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  unsaved = { ...unsaved, [key]: value }
  prefs = { ...(load() ?? prefs), [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
    // Everything this tab had unsaved went with it.
    unsaved = {}
    // index.html reads this key before first paint.
    if (key === 'theme') localStorage.setItem('trioditis.theme', value as string)
  } catch {
    // Storage can be blocked or full; the choice still applies here until the page reloads.
  }
  if (key === 'theme') applyTheme()
  listeners.forEach((l) => l())
}

export function subscribePrefs(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** This tab's copy, as the screen shows it. */
export const shownPrefs = () => prefs

export function usePrefs(): Prefs {
  return useSyncExternalStore(subscribePrefs, shownPrefs)
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && darkQuery.matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}
darkQuery.addEventListener('change', applyTheme)
// Another tab saved a change (a null key is storage being cleared).
window.addEventListener('storage', (e) => {
  if (e.key === KEY || e.key === null) reload()
})
