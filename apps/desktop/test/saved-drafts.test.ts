import { generateKeyPair, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { loadDrafts, saveDrafts, savedDraftsKey, type DraftStorage } from '../src/data/saved-drafts.ts'

beforeAll(ready)

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const draft = (text: string, reply: { eventId: string; body: string } | null = null) => ({ text, reply })

describe('drafts saved across a reload', () => {
  it('come back after a reload, text and reply', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDrafts(storage, owner, ['c1'], new Map([['c1', draft('see you at 7', { eventId: 'e1', body: 'when?' })]]))
    expect(loadDrafts(storage, owner).get('c1')).toEqual(draft('see you at 7', { eventId: 'e1', body: 'when?' }))
  })

  it('are stored sealed: no text, reply or plaintext of any kind on disk', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDrafts(
      storage,
      owner,
      ['c1'],
      new Map([['c1', draft('the secret plan', { eventId: 'wamid.HBgLreplytarget', body: 'quoted words' })]]),
    )
    const raw = storage.data.get(savedDraftsKey('u1'))!
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('quoted')
    expect(raw).not.toContain('replytarget')
  })

  it('open only for their owner’s key and their own chat', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDrafts(storage, owner, ['c1'], new Map([['c1', draft('hi')]]))
    expect(loadDrafts(storage, { userId: 'u1', keyPair: generateKeyPair() }).size).toBe(0)
    // A saved draft moved to another chat's place doesn't open there.
    const stored = JSON.parse(storage.data.get(savedDraftsKey('u1'))!) as Record<string, unknown>
    storage.setItem(savedDraftsKey('u1'), JSON.stringify({ c2: stored.c1 }))
    expect(loadDrafts(storage, owner).size).toBe(0)
  })

  it('keep what another tab saved for chats this one didn’t change, and drop emptied ones', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    // Tab A saves c1; tab B, which never touched c1, saves c2.
    saveDrafts(storage, owner, ['c1'], new Map([['c1', draft('from A')]]))
    saveDrafts(storage, owner, ['c2'], new Map([['c2', draft('from B')]]))
    expect([...loadDrafts(storage, owner)]).toEqual([
      ['c1', draft('from A')],
      ['c2', draft('from B')],
    ])
    // Tab A sends c1: its draft is empty now, and its saved copy goes.
    saveDrafts(storage, owner, ['c1'], new Map())
    expect([...loadDrafts(storage, owner).keys()]).toEqual(['c2'])
    saveDrafts(storage, owner, ['c2'], new Map([['c2', draft('  ')]]))
    expect(storage.data.has(savedDraftsKey('u1'))).toBe(false)
  })

  it('treats a damaged entry as nothing saved', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    storage.setItem(savedDraftsKey('u1'), '{not json')
    expect(loadDrafts(storage, owner).size).toBe(0)
    storage.setItem(savedDraftsKey('u1'), JSON.stringify({ c1: { nonsense: true } }))
    expect(loadDrafts(storage, owner).size).toBe(0)
  })
})
