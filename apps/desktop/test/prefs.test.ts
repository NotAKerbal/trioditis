import { beforeEach, describe, expect, it, vi } from 'vitest'

// prefs.ts reads the browser as it loads, so each test gives it a fresh stand-in: storage that
// two tabs share, and this tab's `storage` events.

const KEY = 'trioditis.prefs'
let stored: Map<string, string>
let onStorage: ((e: { key: string | null }) => void)[]

async function freshTab() {
  vi.resetModules()
  onStorage = []
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
  })
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    addEventListener: (type: string, listener: (e: { key: string | null }) => void) => {
      if (type === 'storage') onStorage.push(listener)
    },
  })
  vi.stubGlobal('document', { documentElement: { dataset: {} } })
  return await import('../src/lib/prefs.ts')
}

/** Another tab saving `prefs`: storage changes, and this tab hears of it. */
function otherTabSaves(prefs: object) {
  stored.set(KEY, JSON.stringify(prefs))
  for (const listener of onStorage) listener({ key: KEY })
}

beforeEach(() => {
  stored = new Map()
})

describe('notification preferences', () => {
  it('show neither sender nor text until the person chooses more', async () => {
    const { currentPrefs } = await freshTab()
    expect(currentPrefs().notificationDetail).toBe('hidden')
  })

  it('show the least for a stored value this version doesn’t know', async () => {
    stored.set(KEY, JSON.stringify({ notificationDetail: 'everything', notificationContent: 'message' }))
    const { currentPrefs } = await freshTab()
    expect(currentPrefs().notificationDetail).toBe('hidden')
    expect(currentPrefs()).not.toHaveProperty('notificationContent')
  })

  it('follow a change another tab makes, as soon as it says so', async () => {
    const { setPref, shownPrefs, subscribePrefs } = await freshTab()
    setPref('notifications', true)
    setPref('notificationDetail', 'message')
    const heard = vi.fn()
    subscribePrefs(heard)
    otherTabSaves({ ...shownPrefs(), notifications: false })
    expect(shownPrefs().notifications).toBe(false)
    expect(shownPrefs().notificationDetail).toBe('message')
    expect(heard).toHaveBeenCalledTimes(1)
    // The same again changes nothing, so nothing re-renders.
    otherTabSaves({ ...shownPrefs() })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('are read from storage again when a notification is due, even if the event never came', async () => {
    const { currentPrefs, setPref } = await freshTab()
    setPref('notificationDetail', 'message')
    // Another tab turns notifications off; this tab hasn't heard yet.
    stored.set(KEY, JSON.stringify({ ...JSON.parse(stored.get(KEY)!), notifications: false, notificationDetail: 'hidden' }))
    expect(currentPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
  })
})
