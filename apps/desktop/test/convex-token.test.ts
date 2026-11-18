import { describe, expect, it } from 'vitest'
import { tokenSession } from '../src/lib/auth-client.ts'

const jwt = (claims: object) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

describe('the session a Convex token names', () => {
  it('reads the sessionId claim', () => {
    expect(tokenSession(jwt({ sub: 'u1', sessionId: 's-1' }))).toBe('s-1')
  })

  it('names none for a token without one, or that isn’t a token', () => {
    expect(tokenSession(jwt({ sub: 'u1' }))).toBeNull()
    expect(tokenSession(jwt({ sessionId: 7 }))).toBeNull()
    expect(tokenSession('not a token')).toBeNull()
  })
})
