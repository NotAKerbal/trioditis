import { describe, expect, it, vi } from 'vitest'
import { dotBitmap } from '../electron/badge.ts'
import { invitationFrom, linkArgument } from '../electron/links.ts'

// desktop.ts reads the bridge off `window` when it loads; in a browser there is none.
vi.stubGlobal('window', {})
const { desktopInvitation } = await import('../src/lib/desktop.ts')

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'

describe('an invitation link handed to the desktop app', () => {
  it('opens the invitation page on the server it names, rebuilt from its parts', () => {
    expect(invitationFrom(`trioditis://chat.example.com/invite?email=a%40b.com#token=${TOKEN}`)).toEqual({
      origin: 'https://chat.example.com',
      url: `https://chat.example.com/invite?email=a%40b.com#token=${TOKEN}`,
    })
    expect(invitationFrom(`TRIODITIS://Chat.Example.com:8443/invite?email=a@b.com#token=${TOKEN}`)).toEqual({
      origin: 'https://chat.example.com:8443',
      url: `https://chat.example.com:8443/invite?email=a%40b.com#token=${TOKEN}`,
    })
  })

  it('takes a server on this machine as plain http, as the picker does', () => {
    expect(invitationFrom(`trioditis://localhost:5181/invite?email=a@b.com#token=${TOKEN}`)?.origin).toBe(
      'http://localhost:5181',
    )
    expect(invitationFrom(`trioditis://[::1]:5181/invite?email=a@b.com#token=${TOKEN}`)?.origin).toBe(
      'http://[::1]:5181',
    )
  })

  it('refuses anything but an invitation', () => {
    const ok = `/invite?email=a@b.com#token=${TOKEN}`
    for (const bad of [
      '',
      'trioditis://',
      `https://chat.example.com${ok}`,
      `trioditis:chat.example.com${ok}`,
      `trioditis://chat.example.com/sign-in?email=a@b.com#token=${TOKEN}`,
      `trioditis://chat.example.com/invite/../settings?email=a@b.com#token=${TOKEN}`,
      `trioditis://chat.example.com//evil.example/invite?email=a@b.com#token=${TOKEN}`,
      `trioditis://user:pw@chat.example.com${ok}`,
      `trioditis://evil.example@chat.example.com${ok}`,
      `trioditis://evil.example\\@chat.example.com${ok}`,
      `trioditis://chat.example.com/invite?email=a@b.com&next=https://evil.example#token=${TOKEN}`,
      `trioditis://chat.example.com/invite?email=a@b.com#token=${TOKEN}&next=x`,
      `trioditis://chat.example.com/invite?email=a@b.com#token=short`,
      `trioditis://chat.example.com/invite?email=a@b.com#token=${TOKEN}<script>`,
      `trioditis://chat.example.com/invite?email=not-an-address#token=${TOKEN}`,
      `trioditis://chat.example.com/invite?email=a%0A@b.com#token=${TOKEN}`,
      `trioditis://chat.example.com/invite#token=${TOKEN}`,
      `trioditis://chat.example.com/invite?email=a@b.com`,
      `trioditis://chat.example.com${ok}${'x'.repeat(5000)}`,
    ])
      expect(invitationFrom(bad), bad).toBeNull()
  })

  it('is found among a launch’s arguments only as an argument of its own', () => {
    const link = `trioditis://chat.example.com/invite?email=a@b.com#token=${TOKEN}`
    expect(linkArgument(['/opt/Trioditis/trioditis', '--no-sandbox', link])).toBe(link)
    expect(linkArgument(['/opt/Trioditis/trioditis', `--server=${link}`])).toBeUndefined()
    expect(linkArgument(['/opt/Trioditis/trioditis'])).toBeUndefined()
  })

  it('is what a browser’s invitation page offers, for a server the app can reach', () => {
    const https = { protocol: 'https:', hostname: 'chat.example.com', host: 'chat.example.com' }
    const offered = desktopInvitation(undefined, https, 'a@b.com', TOKEN)
    expect(offered).not.toBeNull()
    expect(invitationFrom(offered!)?.url).toBe(`https://chat.example.com/invite?email=a%40b.com#token=${TOKEN}`)
    const local = { protocol: 'http:', hostname: 'localhost', host: 'localhost:5181' }
    expect(invitationFrom(desktopInvitation(undefined, local, 'a@b.com', TOKEN)!)?.origin).toBe('http://localhost:5181')
    // Plain http elsewhere, or https on this machine, isn't how the app would open it.
    expect(desktopInvitation(undefined, { ...https, protocol: 'http:' }, 'a@b.com', TOKEN)).toBeNull()
    expect(desktopInvitation(undefined, { ...local, protocol: 'https:' }, 'a@b.com', TOKEN)).toBeNull()
    // Already in the app: nothing to offer.
    expect(desktopInvitation({ setBadge() {}, focus() {}, platform: 'win32' }, https, 'a@b.com', TOKEN)).toBeNull()
  })
})

describe('the Windows badge dot', () => {
  it('is an opaque red dot with transparent corners', () => {
    const size = 32
    const pixels = dotBitmap(size)
    expect(pixels.length).toBe(size * size * 4)
    const at = (x: number, y: number) => [...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]
    // BGRA: #dc2626.
    expect(at(16, 16)).toEqual([0x26, 0x26, 0xdc, 0xff])
    expect(at(0, 0)).toEqual([0, 0, 0, 0])
    expect(at(31, 31)).toEqual([0, 0, 0, 0])
  })
})
