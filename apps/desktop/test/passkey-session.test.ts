import { describe, expect, it } from 'vitest'
import { setPageSession, withPageSession } from '../src/lib/auth-client.ts'
import { authSessionChanged, errorMessage, tooManyAttempts } from '../src/lib/errors.ts'

const request = (path: string) => ({ url: `http://localhost:5182/api/auth${path}`, headers: new Headers() })

describe('adding a passkey, bound to the page’s session', () => {
  it('sends nothing before the page has opened a session', () => {
    const r = withPageSession(request('/passkey/generate-register-options'))
    expect(r.headers.has('x-trioditis-session-id')).toBe(false)
  })

  it('names the page’s session on both registration requests, and only those', () => {
    setPageSession('s-1')
    // A later session doesn't replace the one the page opened with.
    setPageSession('s-2')
    for (const path of ['/passkey/generate-register-options', '/passkey/verify-registration']) {
      expect(withPageSession(request(path)).headers.get('x-trioditis-session-id')).toBe('s-1')
    }
    for (const path of ['/passkey/generate-authenticate-options', '/passkey/verify-authentication', '/get-session']) {
      expect(withPageSession(request(path)).headers.has('x-trioditis-session-id')).toBe(false)
    }
  })

  it('starts the page again when the server says its session changed (409)', () => {
    const changed = {
      status: 409,
      code: 'sessionChanged',
      message: 'This page’s session has changed. Reload the page.',
    }
    expect(authSessionChanged(changed)).toBe(true)
    expect(authSessionChanged({ status: 409, code: 'SOMETHING_ELSE' })).toBe(false)
    expect(authSessionChanged({ status: 400, code: 'sessionChanged' })).toBe(false)
    expect(authSessionChanged(null)).toBe(false)
  })

  it('says how long to wait when over the limit (429), and the server’s words otherwise', () => {
    const limited = { status: 429, message: 'Too many requests. Please try again later.' }
    expect(tooManyAttempts(limited, 8)).toBe('Too many attempts. Try again in 8 seconds.')
    expect(authSessionChanged(limited)).toBe(false)
    const cancelled = { status: 400, message: 'auth cancelled' }
    expect(tooManyAttempts(cancelled, 8)).toBeNull()
    expect(errorMessage(cancelled, 'That passkey couldn’t be added.')).toBe('auth cancelled')
  })
})
