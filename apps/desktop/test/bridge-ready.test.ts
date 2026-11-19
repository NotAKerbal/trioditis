import { describe, expect, it } from 'vitest'
import {
  BRIDGE_LOOKUP_FAILED,
  composerBlocked,
  loginInputBlocked,
  NO_BRIDGE_LOGIN,
  NO_BRIDGE_SEND,
} from '../src/data/bridge-ready.ts'

const open = { blocked: false, isRequest: false }

describe('sending needs the bridge key', () => {
  it('disables the composer, saying why, when the server has no bridge key', () => {
    expect(composerBlocked(open, 'missing')).toBe(NO_BRIDGE_SEND)
  })

  it('says a failed lookup apart from a missing key', () => {
    expect(composerBlocked(open, 'error')).toBe(BRIDGE_LOOKUP_FAILED)
    expect(loginInputBlocked('error')).toBe(BRIDGE_LOOKUP_FAILED)
  })

  it('leaves it alone while the key is loading, and once it’s there', () => {
    expect(composerBlocked(open, 'loading')).toBeNull()
    expect(composerBlocked(open, 'ready')).toBeNull()
  })

  it('says the chat’s own reason first', () => {
    expect(composerBlocked({ blocked: true, isRequest: false }, 'missing')).toBe('You blocked this chat')
    expect(composerBlocked({ blocked: false, isRequest: true }, 'missing')).toBe('Accept the request to reply')
  })

  it('disables a login step’s input without a bridge key, and not while it loads', () => {
    expect(loginInputBlocked('missing')).toBe(NO_BRIDGE_LOGIN)
    expect(loginInputBlocked('loading')).toBeNull()
    expect(loginInputBlocked('ready')).toBeNull()
  })
})
