import { describe, expect, it, vi } from 'vitest'

// desktop.ts reads the bridge off `window` when it loads; in a browser there is none.
vi.stubGlobal('window', {})
const { serverSwitcher } = await import('../src/lib/desktop.ts')

const location = { host: 'home.tailnet.ts.net' }

describe('the sign-in page’s server switcher', () => {
  it('names the server and opens the desktop app’s picker', () => {
    const changeServer = vi.fn()
    const server = serverSwitcher({ setBadge() {}, focus() {}, platform: 'darwin', changeServer }, location)
    expect(server?.host).toBe('home.tailnet.ts.net')
    server?.change()
    expect(changeServer).toHaveBeenCalledOnce()
  })

  it('isn’t offered in a browser', () => {
    expect(serverSwitcher(undefined, location)).toBeNull()
  })

  it('isn’t offered by a desktop app from before it could open the picker', () => {
    expect(serverSwitcher({ setBadge() {}, focus() {}, platform: 'darwin' }, location)).toBeNull()
  })
})
