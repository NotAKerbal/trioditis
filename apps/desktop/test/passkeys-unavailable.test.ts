import { describe, expect, it, vi } from 'vitest'

// desktop.ts reads the bridge off `window` when it loads; in a browser there is none.
vi.stubGlobal('window', {})
const { passkeysUnavailableIn } = await import('../src/lib/desktop.ts')

const app = (platform: string) => ({ setBadge() {}, focus() {}, platform })

describe('where the passkey buttons are disabled', () => {
  it('never in a browser, which decides for itself', () => {
    expect(passkeysUnavailableIn(undefined, true)).toBeNull()
    expect(passkeysUnavailableIn(undefined, false)).toBeNull()
  })

  it('in the desktop app on a Mac and Linux, saying why', () => {
    expect(passkeysUnavailableIn(app('darwin'), true)).toMatch(/on a Mac/)
    expect(passkeysUnavailableIn(app('linux'), true)).toMatch(/on Linux/)
    expect(passkeysUnavailableIn(app('freebsd'), true)).toMatch(/this system/)
  })

  it('on Windows only when the page has no WebAuthn', () => {
    expect(passkeysUnavailableIn(app('win32'), true)).toBeNull()
    expect(passkeysUnavailableIn(app('win32'), false)).toMatch(/don’t work/)
  })
})
