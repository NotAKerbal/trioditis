import { generateKeyPair, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  adoptDraft,
  clearSentDraft,
  getDraft,
  markDraftSent,
  restoreDraft,
  setDraftText,
  takeDraft,
} from '../src/data/drafts.ts'
import {
  draftChatOf,
  draftSendId,
  loadDrafts,
  parseEntry,
  saveDraft,
  savedDraftKey,
  type DraftStorage,
} from '../src/data/saved-drafts.ts'

beforeAll(ready)

function memory(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    get length() {
      return data.size
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

type Reply = { eventId: string; body: string }
const draft = (text: string, id = 'id-1', reply: Reply | null = null) => ({ text, reply, id })
let n = 0
const chat = () => `chat-${++n}`

describe('drafts saved across a reload', () => {
  it('come back after a reload, text, reply and identity', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDraft(storage, owner, 'c1', draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }))
    expect(loadDrafts(storage, owner).get('c1')).toEqual(
      draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }),
    )
  })

  it('are stored sealed: no text, reply or plaintext of any kind on disk', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDraft(
      storage,
      owner,
      'c1',
      draft('the secret plan', 'id-1', { eventId: 'wamid.HBgLreplytarget', body: 'quoted words' }),
    )
    const raw = [...storage.data.values()].join()
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('quoted')
    expect(raw).not.toContain('replytarget')
  })

  it('open only for their owner’s key and their own chat', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDraft(storage, owner, 'c1', draft('hi'))
    expect(loadDrafts(storage, { userId: 'u1', keyPair: generateKeyPair() }).size).toBe(0)
    // A saved draft moved to another chat's place doesn't open there.
    storage.setItem(savedDraftKey('u1', 'c2'), storage.getItem(savedDraftKey('u1', 'c1'))!)
    storage.removeItem(savedDraftKey('u1', 'c1'))
    expect(loadDrafts(storage, owner).size).toBe(0)
  })

  it('keep one entry per chat, so saving one chat never touches another', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDraft(storage, owner, 'c1', draft('from A'))
    saveDraft(storage, owner, 'c2', draft('from B'))
    expect([...loadDrafts(storage, owner).keys()].sort()).toEqual(['c1', 'c2'])
    saveDraft(storage, owner, 'c1', null)
    expect([...loadDrafts(storage, owner).keys()]).toEqual(['c2'])
    expect(draftChatOf('u1', savedDraftKey('u1', 'c2'))).toBe('c2')
    expect(draftChatOf('u2', savedDraftKey('u1', 'c2'))).toBeNull()
  })

  it('leave a note of the send that emptied one, and nothing to bring back', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    saveDraft(storage, owner, 'c1', draft('hi'))
    saveDraft(storage, owner, 'c1', null, 'd_sent')
    expect(parseEntry(storage.getItem(savedDraftKey('u1', 'c1')))).toEqual({ v: 1, sent: 'd_sent' })
    expect(loadDrafts(storage, owner).size).toBe(0)
  })

  it('treat a damaged entry as nothing saved', () => {
    const storage = memory()
    const owner = { userId: 'u1', keyPair: generateKeyPair() }
    storage.setItem(savedDraftKey('u1', 'c1'), '{not json')
    storage.setItem(savedDraftKey('u1', 'c2'), JSON.stringify({ v: 1, id: 'x', sealed: { nonsense: true } }))
    expect(loadDrafts(storage, owner).size).toBe(0)
  })
})

describe('a restored draft sent from two tabs', () => {
  it('is one send: both tabs work out the same client message ID', () => {
    const a = chat()
    const b = chat()
    // Two tabs bring back the same saved draft.
    adoptDraft(a, 'see you at 7', null, 'saved-id')
    adoptDraft(b, 'see you at 7', null, 'saved-id')
    const takenA = takeDraft(a)!
    const takenB = takeDraft(b)!
    const idA = draftSendId(takenA.id, takenA.text, undefined)
    expect(draftSendId(takenB.id, takenB.text, undefined)).toBe(idA)
    expect(idA).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('is another send once either tab changes it', () => {
    expect(draftSendId('saved-id', 'see you at 7', undefined)).not.toBe(
      draftSendId('saved-id', 'see you at 8', undefined),
    )
    expect(draftSendId('saved-id', 'hi', 'e1')).not.toBe(draftSendId('saved-id', 'hi', undefined))
    expect(draftSendId('one', 'hi', undefined)).not.toBe(draftSendId('two', 'hi', undefined))
  })

  it('empties the other tab’s copy if it is still the same, and keeps it if it changed', () => {
    const a = chat()
    adoptDraft(a, 'see you at 7', null, 'saved-id')
    const sent = draftSendId('saved-id', 'see you at 7', undefined)
    const same = (d: { id: string; text: string }) => draftSendId(d.id, d.text, undefined) === sent
    expect(clearSentDraft(a, same)).toBe(true)
    expect(getDraft(a).text).toBe('')
    const b = chat()
    adoptDraft(b, 'see you at 7', null, 'saved-id')
    setDraftText(b, 'see you at 7, or 8')
    expect(clearSentDraft(b, same)).toBe(false)
    expect(getDraft(b).text).toBe('see you at 7, or 8')
  })
})

describe('a draft’s identity', () => {
  it('is new for each draft, and kept while it is edited', () => {
    const a = chat()
    setDraftText(a, 'h')
    const first = getDraft(a).id
    expect(first).not.toBe('')
    setDraftText(a, 'hi')
    expect(getDraft(a).id).toBe(first)
    takeDraft(a)
    expect(getDraft(a).id).toBe('')
    setDraftText(a, 'hi')
    expect(getDraft(a).id).not.toBe(first)
  })

  it('comes back with a send that didn’t go, so trying again is the same send', () => {
    const a = chat()
    setDraftText(a, 'hi')
    const taken = takeDraft(a)!
    restoreDraft(a, taken.text, taken.reply, taken.id)
    expect(getDraft(a).id).toBe(taken.id)
  })

  it('records the send that emptied it, until something is typed again', () => {
    const a = chat()
    setDraftText(a, 'hi')
    takeDraft(a)
    markDraftSent(a, 'd_x')
    expect(getDraft(a).sent).toBe('d_x')
    setDraftText(a, 'next')
    expect(getDraft(a).sent).toBeNull()
    // Typed while the send was on its way: nothing to mark.
    const b = chat()
    setDraftText(b, 'one')
    takeDraft(b)
    setDraftText(b, 'two')
    markDraftSent(b, 'd_y')
    expect(getDraft(b)).toMatchObject({ text: 'two', sent: null })
  })

  it('doesn’t replace what’s typed when a saved draft comes back', () => {
    const a = chat()
    setDraftText(a, 'typed here')
    adoptDraft(a, 'saved', null, 'saved-id')
    expect(getDraft(a).text).toBe('typed here')
  })
})
