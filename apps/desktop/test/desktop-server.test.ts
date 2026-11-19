import { describe, expect, it } from 'vitest'
import { isExternalAllowed, looksLikeTrioditis, normalizeServer, sameOrigin } from '../electron/server.ts'

describe('the desktop app’s server address', () => {
  it('takes a bare host as https, and keeps only the origin', () => {
    expect(normalizeServer(' trioditis.example.com ')).toEqual({ origin: 'https://trioditis.example.com' })
    expect(normalizeServer('https://host.ts.net:8443/some/path?x=1')).toEqual({ origin: 'https://host.ts.net:8443' })
  })

  it('allows plain http only on this machine', () => {
    expect(normalizeServer('http://localhost:5181')).toEqual({ origin: 'http://localhost:5181' })
    expect(normalizeServer('http://127.0.0.1:8080')).toEqual({ origin: 'http://127.0.0.1:8080' })
    expect(normalizeServer('http://[::1]:8080')).toEqual({ origin: 'http://[::1]:8080' })
    expect(normalizeServer('http://192.168.1.5')).toHaveProperty('error')
    expect(normalizeServer('http://localhost.example.com')).toHaveProperty('error')
  })

  it('refuses what isn’t a web address', () => {
    for (const bad of ['', '   ', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://host', 'https://user:pw@host'])
      expect(normalizeServer(bad)).toHaveProperty('error')
  })
})

describe('telling a Trioditis server', () => {
  it('by its config, or by the page’s marker', () => {
    expect(looksLikeTrioditis({ config: { convexUrl: 'https://x.convex.cloud' } })).toBe(true)
    expect(looksLikeTrioditis({ config: { convexUrl: '' } })).toBe(false)
    expect(looksLikeTrioditis({ config: null })).toBe(false)
    expect(looksLikeTrioditis({ html: '<meta name="application-name" content="Trioditis" />' })).toBe(true)
    expect(looksLikeTrioditis({ html: '<title>Trioditis</title>' })).toBe(false)
  })
})

describe('where the app goes', () => {
  it('stays on the server’s origin and hands only web and mail links out', () => {
    expect(sameOrigin('https://a.example/x', 'https://a.example')).toBe(true)
    expect(sameOrigin('https://a.example.evil.com/', 'https://a.example')).toBe(false)
    expect(sameOrigin('not a url', 'https://a.example')).toBe(false)
    expect(isExternalAllowed('https://example.com')).toBe(true)
    expect(isExternalAllowed('mailto:a@example.com')).toBe(true)
    expect(isExternalAllowed('file:///etc/passwd')).toBe(false)
    expect(isExternalAllowed('smb://host/share')).toBe(false)
  })
})
