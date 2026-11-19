import { describe, expect, it } from 'vitest'
import { holdPassword, takePassword } from '../src/lib/pending-password.ts'

describe('the password held from signing in', () => {
  it('goes only to the account it was typed for, once', () => {
    holdPassword('a long password', 'alice')
    expect(takePassword('alice')).toBe('a long password')
    expect(takePassword('alice')).toBeNull()
  })

  it('is dropped, not handed over, when another account’s screen asks for it', () => {
    // Signed in as alice; another tab signed in as bob before this one's screen opened.
    holdPassword('alice’s password', 'alice')
    expect(takePassword('bob')).toBeNull()
    expect(takePassword('alice')).toBeNull()
  })
})
