import { useSyncExternalStore } from 'react'

// This device's display preferences. They live in this browser only, like the theme; nothing
// here is message content.

export type SidebarLayout = 'simple' | 'focused'
export type Theme = 'system' | 'light' | 'dark'

export interface Prefs {
  sidebar: SidebarLayout
  theme: Theme
  previews: boolean
  networkBadges: boolean
}

const DEFAULTS: Prefs = { sidebar: 'simple', theme: 'system', previews: true, networkBadges: true }
const KEY = 'trioditis.prefs'

function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
    return { ...DEFAULTS, ...saved }
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
