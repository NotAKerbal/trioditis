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
  it('show the sender and the message until the person chooses less', async () => {
    const { currentPrefs } = await freshTab()
    expect(currentPrefs().notificationDetail).toBe('message')
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
    stored.set(
      KEY,
      JSON.stringify({ ...JSON.parse(stored.get(KEY)!), notifications: false, notificationDetail: 'hidden' }),
    )
    expect(currentPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
  })
})

describe('two tabs changing preferences', () => {
  it('keep one tab’s opt-out when a stale tab changes something else', async () => {
    // Both tabs open with previews on.
    stored.set(KEY, JSON.stringify({ notifications: true, notificationDetail: 'message' }))
    const a = await freshTab()
    const b = await freshTab()
    // A turns notifications off; B hasn't heard yet and changes its theme.
    a.setPref('notifications', false)
    a.setPref('notificationDetail', 'hidden')
    b.setPref('theme', 'dark')
    expect(JSON.parse(stored.get(KEY)!)).toMatchObject({
      notifications: false,
      notificationDetail: 'hidden',
      theme: 'dark',
    })
    expect(b.currentPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
  })

  it('never turn previews back on from defaults when storage can’t be read', async () => {
    const tab = await freshTab()
    tab.setPref('notifications', false)
    const blocked = () => {
      throw new Error('blocked')
    }
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked })
    expect(tab.currentPrefs().notifications).toBe(false)
    tab.setPref('theme', 'light')
    expect(tab.currentPrefs()).toMatchObject({ notifications: false, theme: 'light' })
  })

  it('keep a choice storage refused to save, though storage still reads the old one', async () => {
    stored.set(KEY, JSON.stringify({ notifications: true, notificationDetail: 'message' }))
    const tab = await freshTab()
    // Storage reads, but every write fails (full, say).
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: () => {
        throw new Error('quota')
      },
    })
    tab.setPref('notificationDetail', 'hidden')
    tab.setPref('notifications', false)
    // A notification is due: what's stored says previews, but the person turned them off.
    expect(tab.currentPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
    expect(tab.shownPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
    // Saving another preference later never writes them as a side effect; they still apply here.
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
    })
    tab.setPref('theme', 'dark')
    expect(JSON.parse(stored.get(KEY)!)).toMatchObject({
      theme: 'dark',
      notifications: true,
      notificationDetail: 'message',
    })
    expect(tab.currentPrefs()).toMatchObject({ theme: 'dark', notifications: false, notificationDetail: 'hidden' })
  })

  it('drop an unsaved choice once another tab saves that preference', async () => {
    stored.set(KEY, JSON.stringify({ notificationDetail: 'message' }))
    const tab = await freshTab()
    const refuse = () => {
      throw new Error('quota')
    }
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: refuse })
    tab.setPref('notificationDetail', 'sender')
    expect(tab.currentPrefs().notificationDetail).toBe('sender')
    // Later, another tab chooses Nothing: that newer choice wins here too.
    otherTabSaves({ notificationDetail: 'hidden' })
    expect(tab.currentPrefs().notificationDetail).toBe('hidden')
    // And this tab's old choice doesn't come back when the other tab moves on.
    otherTabSaves({ notificationDetail: 'message' })
    expect(tab.currentPrefs().notificationDetail).toBe('message')
  })

  it('never show more in notifications from a choice that wasn’t saved', async () => {
    stored.set(KEY, JSON.stringify({ notifications: false, notificationDetail: 'hidden' }))
    const tab = await freshTab()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: () => {
        throw new Error('quota')
      },
    })
    tab.setPref('notificationDetail', 'message')
    tab.setPref('notifications', true)
    expect(tab.currentPrefs()).toMatchObject({ notifications: false, notificationDetail: 'hidden' })
  })
})
