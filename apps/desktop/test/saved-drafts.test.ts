import { generateKeyPair, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  adoptDraft,
  allHeld,
  allSending,
  beginSend,
  clearSentDraft,
  endSend,
  getDraft,
  holdDraft,
  onDraftSent,
  restoreDraft,
  setDraftReply,
  setDraftText,
  takeDraft,
} from '../src/data/drafts.ts'
import {
  draftSendId,
  draftWriter,
  keyOf,
  loadAll,
  parseSent,
  removeDraftIfOurs,
  removeSending,
  savedDraftKey,
  writeDraft,
  writeHeld,
  writeSending,
  writeSent,
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
const owner = () => ({ userId: 'u1', keyPair: generateKeyPair() })
let n = 0
const chat = () => `chat-${++n}`

describe('drafts saved across a reload', () => {
  it('come back after a reload, text, reply and identity', () => {
    const storage = memory()
    const me = owner()
    writeDraft(storage, me, 'c1', draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }))
    expect(loadAll<Reply>(storage, me).drafts.get('c1')).toMatchObject(
      draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }),
    )
  })

  it('are stored sealed: no text, reply or plaintext of any kind on disk', () => {
    const storage = memory()
    const me = owner()
    const secret = draft('the secret plan', 'id-1', { eventId: 'wamid.HBgLreplytarget', body: 'quoted words' })
    writeDraft(storage, me, 'c1', secret)
    writeSending(storage, me, 'c2', 'd_x', secret)
    writeHeld(storage, me, 'c3', [secret])
    const raw = [...storage.data.values()].join()
    for (const word of ['secret', 'quoted', 'replytarget']) expect(raw).not.toContain(word)
  })

  it('open only for their owner’s key and their own chat', () => {
    const storage = memory()
    const me = owner()
    writeDraft(storage, me, 'c1', draft('hi'))
    expect(loadAll(storage, owner()).drafts.size).toBe(0)
    storage.setItem(savedDraftKey('u1', 'c2'), storage.getItem(savedDraftKey('u1', 'c1'))!)
    storage.removeItem(savedDraftKey('u1', 'c1'))
    expect(loadAll(storage, me).drafts.size).toBe(0)
  })

  it('treat a damaged entry as nothing saved', () => {
    const storage = memory()
    storage.setItem(savedDraftKey('u1', 'c1'), '{not json')
    storage.setItem(savedDraftKey('u1', 'c2'), JSON.stringify({ v: 1, id: 'x', w: 'w', sealed: { nonsense: true } }))
    expect(loadAll(storage, owner()).drafts.size).toBe(0)
  })

  it('tell each kind of entry apart, for this person only', () => {
    expect(keyOf('u1', savedDraftKey('u1', 'c1'))).toMatchObject({ kind: 'draft', chatId: 'c1' })
    expect(keyOf('u1', 'trioditis.draftSending.u1.c1.d_abc')).toEqual({
      kind: 'draftSending',
      chatId: 'c1',
      sendId: 'd_abc',
    })
    expect(keyOf('u1', 'trioditis.draftSent.u1.c1')).toMatchObject({ kind: 'draftSent', chatId: 'c1' })
    expect(keyOf('u2', savedDraftKey('u1', 'c1'))).toBeNull()
  })
})

describe('a tab erasing a draft', () => {
  it('removes only the saved draft it wrote or brought back, not another tab’s newer one', () => {
    const storage = memory()
    const me = owner()
    // Tab B opened before tab A saved: B has seen no saved draft for the chat.
    const seenByB: string | undefined = undefined
    // A saves its draft.
    const wA = writeDraft(storage, me, 'c1', draft('from A'))
    // B types and erases in the same chat: its removal leaves A's draft.
    expect(removeDraftIfOurs(storage, 'u1', 'c1', seenByB)).toBe(false)
    expect(loadAll(storage, me).drafts.get('c1')?.text).toBe('from A')
    // A erasing its own does remove it.
    expect(draftWriter(storage, 'u1', 'c1')).toBe(wA)
    expect(removeDraftIfOurs(storage, 'u1', 'c1', wA)).toBe(true)
    expect(loadAll(storage, me).drafts.size).toBe(0)
  })
})

describe('a send under way', () => {
  it('is saved until it settles, and comes back from a reload as a draft that sends as the same', () => {
    const a = chat()
    setDraftText(a, 'see you at 7')
    const taken = takeDraft<Reply>(a)!
    const sendId = draftSendId(taken.id, taken.text, undefined)
    beginSend(a, sendId, taken)
    expect(allSending()).toEqual([[sendId, { ...taken, chatId: a }]])
    // The page crashes before the server has it: what's saved is the send under way.
    const storage = memory()
    const me = owner()
    writeSending(storage, me, a, sendId, taken)
    const loaded = loadAll<Reply>(storage, me)
    expect(loaded.sending).toEqual([{ chatId: a, sendId, draft: { text: 'see you at 7', reply: null, id: taken.id } }])
    // Brought back as the same draft: sending it again is the same send ID, so it dedupes.
    const back = loaded.sending[0]!.draft
    expect(draftSendId(back.id, back.text, undefined)).toBe(sendId)
    endSend(sendId, false)
    expect(allSending()).toEqual([])
  })

  it('is announced when it goes, apart from whatever the composer holds by then', () => {
    const a = chat()
    const heard: string[] = []
    const stop = onDraftSent((chatId, id) => heard.push(`${chatId}:${id}`))
    setDraftText(a, 'one')
    const taken = takeDraft<Reply>(a)!
    beginSend(a, 'd_one', taken)
    // A new draft started while the first was on its way.
    setDraftText(a, 'two')
    endSend('d_one', true)
    stop()
    expect(heard).toEqual([`${a}:d_one`])
    expect(getDraft(a).text).toBe('two')
  })

  it('leaves a note other tabs and the next load read', () => {
    const storage = memory()
    writeSent(storage, 'u1', 'c1', 'd_one')
    expect(parseSent(storage.getItem('trioditis.draftSent.u1.c1'))).toBe('d_one')
    expect(loadAll(storage, owner()).sent.get('c1')).toBe('d_one')
    removeSending(storage, 'u1', 'c1', 'd_one')
  })
})

describe('a restored draft sent from two tabs', () => {
  it('is one send: both tabs work out the same client message ID', () => {
    const a = chat()
    const b = chat()
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

  it('is new once its text is cleared, though the reply stays', () => {
    const a = chat()
    setDraftReply(a, { eventId: 'e1', body: 'q' })
    setDraftText(a, 'ok')
    const first = getDraft(a).id
    // Cleared, reply kept, and the same words typed again: a new message, not the same send.
    setDraftText(a, '')
    setDraftText(a, 'ok')
    expect(getDraft(a).id).not.toBe(first)
    expect(draftSendId(getDraft(a).id, 'ok', 'e1')).not.toBe(draftSendId(first, 'ok', 'e1'))
  })

  it('comes back with a send that didn’t go, so trying again is the same send', () => {
    const a = chat()
    setDraftText(a, 'hi')
    const taken = takeDraft(a)!
    restoreDraft(a, taken.text, taken.reply, taken.id)
    expect(getDraft(a).id).toBe(taken.id)
  })

  it('doesn’t replace what’s typed when a saved draft comes back', () => {
    const a = chat()
    setDraftText(a, 'typed here')
    expect(adoptDraft(a, 'saved', null, 'saved-id')).toBe(false)
    expect(getDraft(a).text).toBe('typed here')
  })
})

describe('a held message', () => {
  it('waits for the composer to be free, never joining a draft that replies elsewhere', () => {
    const a = chat()
    setDraftReply(a, { eventId: 'e2', body: 'other' })
    setDraftText(a, 'my reply to e2')
    holdDraft<Reply>(a, { text: 'cancelled', reply: { eventId: 'e1', body: 'q' } })
    expect(getDraft(a).text).toBe('my reply to e2')
    expect(allHeld()).toEqual([[a, [{ text: 'cancelled', reply: { eventId: 'e1', body: 'q' } }]]])
    // The draft goes: the held message takes its place, with its own reply.
    takeDraft(a)
    expect(getDraft<Reply>(a)).toMatchObject({ text: 'cancelled', reply: { eventId: 'e1' } })
    expect(allHeld().filter(([c]) => c === a)).toEqual([])
  })

  it('goes straight into an empty composer, as the same draft when it has an identity', () => {
    const a = chat()
    holdDraft(a, { text: 'back', reply: null, id: 'kept-id' })
    expect(getDraft(a)).toMatchObject({ text: 'back', id: 'kept-id' })
  })
})
