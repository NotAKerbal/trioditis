import { generateKeyPair, keyId, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { coldSession, forgetVerified, readVerified, rememberVerified } from '../src/lib/verified-session.ts'

beforeAll(ready)

function store() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

describe('the last confirmed session, for a cold start offline', () => {
  const keyPair = generateKeyPair()
  const kid = keyId(keyPair.publicKey)
  const verified = { userId: 'u1', sessionId: 's1', role: 'member' as const, kid }

  it('keeps only IDs, and reads back what it kept', () => {
    const s = store()
    rememberVerified({ ...verified, keyPair } as never, s)
    expect(JSON.parse([...s.map.values()][0]!)).toEqual(verified)
    expect(readVerified(s)).toEqual(verified)
    forgetVerified(s)
    expect(readVerified(s)).toBeNull()
  })

  it('reads nothing from a record that isn’t one', () => {
    const s = store()
    s.setItem('trioditis-verified-session', '{"userId":"u1","role":"owner"}')
    expect(readVerified(s)).toBeNull()
    s.setItem('trioditis-verified-session', 'not json')
    expect(readVerified(s)).toBeNull()
    expect(readVerified(null)).toBeNull()
  })

  it('opens only with this device’s key for that account, and the same key', () => {
    expect(coldSession(verified, { kid, keyPair })).toEqual({ ...verified, keyPair })
    // Signed out here (the key is gone), or another key: nothing to open with.
    expect(coldSession(verified, null)).toBeNull()
    expect(coldSession(verified, { kid: 'other', keyPair })).toBeNull()
    expect(coldSession(null, { kid, keyPair })).toBeNull()
  })
})
