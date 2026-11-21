import { describe, expect, it } from 'vitest'
import {
  dropConsentReturn,
  holdConsentReturn,
  isRequestId,
  lastUsed,
  peekConsentReturn,
  returnsTo,
} from '../src/lib/agent-connect.ts'

function memory() {
  const items = new Map<string, string>()
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  }
}

describe('coming back to an agent’s consent page after signing in', () => {
  it('goes back to the request it held, while that can still be answered', () => {
    const store = memory()
    holdConsentReturn('req_abcDEF-123_xyz', store, 1_000)
    expect(peekConsentReturn(store, 2_000)).toBe('req_abcDEF-123_xyz')
    // Read, not taken: a second render finds it too.
    expect(peekConsentReturn(store, 2_000)).toBe('req_abcDEF-123_xyz')
    expect(peekConsentReturn(store, 1_000 + 11 * 60_000)).toBeNull()
    dropConsentReturn(store)
    expect(peekConsentReturn(store, 2_000)).toBeNull()
  })

  it('only ever goes to the consent page, whatever else is stored', () => {
    const store = memory()
    holdConsentReturn('https://evil.example/', store, 1_000)
    expect(store.items.size).toBe(0)
    store.setItem('trioditis.agentConnectReturn', JSON.stringify({ requestId: '../../evil', at: 1_000 }))
    expect(peekConsentReturn(store, 2_000)).toBeNull()
    store.setItem('trioditis.agentConnectReturn', '{not json')
    expect(peekConsentReturn(store, 2_000)).toBeNull()
    // One held "later than now" is a clock that moved, not a fresh request.
    store.setItem('trioditis.agentConnectReturn', JSON.stringify({ requestId: 'req_abcdefgh', at: 5_000 }))
    expect(peekConsentReturn(store, 2_000)).toBeNull()
  })

  it('works without storage', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(() => holdConsentReturn('req_abcdefgh', broken)).not.toThrow()
    expect(peekConsentReturn(broken)).toBeNull()
    expect(() => dropConsentReturn(broken)).not.toThrow()
  })

  it('accepts only request IDs shaped like the server’s', () => {
    expect(isRequestId('mcp_req_0123456789abcdef')).toBe(true)
    expect(isRequestId('short')).toBe(false)
    expect(isRequestId('a/b?c=d&e')).toBe(false)
    expect(isRequestId(42)).toBe(false)
  })
})

describe('the consent page', () => {
  it('says where approval sends the browser back to', () => {
    expect(returnsTo('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai')
    expect(returnsTo('http://127.0.0.1:4567/callback')).toBe('127.0.0.1:4567')
    expect(returnsTo('cursor://anysphere.cursor-mcp/oauth')).toBe('cursor://')
    expect(returnsTo(undefined)).toBeNull()
    expect(returnsTo('not a url')).toBeNull()
  })
})

describe('Settings → Agents', () => {
  it('says when a connection was last used', () => {
    const now = Date.UTC(2026, 10, 20, 12)
    expect(lastUsed(undefined, now)).toBe('Never used')
    expect(lastUsed(now - 60_000, now)).toBe('Used today')
    expect(lastUsed(now - 30 * 3_600_000, now)).toBe('Used yesterday')
    expect(lastUsed(now - 10 * 86_400_000, now)).toMatch(/^Used /)
  })
})
