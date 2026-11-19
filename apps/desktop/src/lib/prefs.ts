import { useSyncExternalStore } from 'react'

// This device's display preferences: they live in this browser only. The sidebar layout follows
// the person across devices, so it is stored on the server instead (data/preferences.ts).

export type Theme = 'system' | 'light' | 'dark'

export interface Prefs {
  theme: Theme
  previews: boolean
  networkBadges: boolean
  /** Notify for new messages, once the browser allows it. */
  notifications: boolean
}

const DEFAULTS: Prefs = {
  theme: 'system',
  previews: true,
  networkBadges: true,
  notifications: true,
}
const KEY = 'trioditis.prefs'

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    // Only today's preferences: one that's gone (notificationContent, say) isn't kept or saved.
    const known = Object.fromEntries(Object.entries(saved).filter(([key]) => key in DEFAULTS))
    return { ...DEFAULTS, ...known } as Prefs
  } catch {
    return DEFAULTS
  }
}

let prefs = load()
const listeners = new Set<() => void>()

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]) {
  prefs = { ...prefs, [key]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
    // index.html reads this key before first paint.
    if (key === 'theme') localStorage.setItem('trioditis.theme', value as string)
  } catch {
    // Storage can be blocked; the choice still applies until the page reloads.
  }
  if (key === 'theme') applyTheme()
  listeners.forEach((l) => l())
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => prefs,
  )
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function applyTheme() {
  const dark = prefs.theme === 'dark' || (prefs.theme === 'system' && darkQuery.matches)
  if (dark) document.documentElement.dataset.theme = 'dark'
  else delete document.documentElement.dataset.theme
}
darkQuery.addEventListener('change', applyTheme)
