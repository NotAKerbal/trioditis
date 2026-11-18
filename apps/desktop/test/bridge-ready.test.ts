import { describe, expect, it } from 'vitest'
import { composerBlocked, loginInputBlocked, NO_BRIDGE_LOGIN, NO_BRIDGE_SEND } from '../src/data/bridge-ready.ts'

const open = { blocked: false, isRequest: false }

describe('sending needs the bridge key', () => {
  it('disables the composer, saying why, when the server has no bridge key', () => {
    expect(composerBlocked(open, null)).toBe(NO_BRIDGE_SEND)
  })

  it('leaves it alone while the key is loading, and once it’s there', () => {
    expect(composerBlocked(open, undefined)).toBeNull()
    expect(composerBlocked(open, 'key')).toBeNull()
  })

  it('says the chat’s own reason first', () => {
    expect(composerBlocked({ blocked: true, isRequest: false }, null)).toBe('You blocked this chat')
    expect(composerBlocked({ blocked: false, isRequest: true }, null)).toBe('Accept the request to reply')
  })

  it('disables a login step’s input without a bridge key, and only then', () => {
    expect(loginInputBlocked(null)).toBe(NO_BRIDGE_LOGIN)
    expect(loginInputBlocked(undefined)).toBeNull()
    expect(loginInputBlocked('key')).toBeNull()
  })
})
