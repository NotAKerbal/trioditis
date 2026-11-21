import { generateKeyPair, ready } from '@trioditis/crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  adoptDraft,
  allSending,
  clearSentDraft,
  endSend,
  getDraft,
  onDraftSent,
  restoreDraft,
  setDraftReply,
  setDraftText,
  subscribeDrafts,
  takeDraft,
  takeForSend,
} from '../src/data/drafts.ts'
import {
  draftSendId,
  keyOf,
  loadAll,
  newKnown,
  parseSent,
  savedDraftKey,
  syncChat,
  withChatLock,
  type ChatWant,
  type DraftStorage,
} from '../src/data/saved-drafts.ts'

beforeAll(ready)
afterEach(() => vi.unstubAllGlobals())

/**
 * Storage two tabs share. `refuse` makes every write fail, as a full one does; `refuseKey` only
 * writes to keys it matches.
 */
function memory(): DraftStorage & { data: Map<string, string>; refuse: boolean; refuseKey: RegExp | null } {
  const data = new Map<string, string>()
  const store = {
    data,
    refuse: false,
    refuseKey: null as RegExp | null,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (store.refuse || store.refuseKey?.test(k)) throw new Error('quota')
      data.set(k, v)
    },
    removeItem: (k: string) => void data.delete(k),
  }
  return store
}

type Reply = { eventId: string; body: string }
const draft = (text: string, id = 'id-1', reply: Reply | null = null) => ({ text, reply, id })
const owner = () => ({ userId: 'u1', keyPair: generateKeyPair() })
const want = (w: Partial<ChatWant<Reply>> = {}): ChatWant<Reply> => ({
  draft: null,
  draftChanged: false,
  sending: new Map(),
  sent: [],
  ...w,
})
let n = 0
const chat = () => `chat-${++n}`

describe('drafts saved across a reload', () => {
  it('come back after a reload: draft and sends under way, each with its identity', () => {
    const storage = memory()
    const me = owner()
    const known = newKnown()
    syncChat(
      storage,
      me,
      'c1',
      want({
        draft: draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }),
        draftChanged: true,
        sending: new Map([['d_s', draft('on its way', 's1')]]),
      }),
      known,
    )
    const loaded = loadAll<Reply>(storage, me)
    expect(loaded.drafts.get('c1')).toMatchObject(draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }))
    expect(loaded.sending).toEqual([{ chatId: 'c1', sendId: 'd_s', copy: draft('on its way', 's1') }])
  })

  it('are stored sealed: no text, reply or plaintext of any kind on disk', () => {
    const storage = memory()
    const secret = draft('the secret plan', 'id-1', { eventId: 'wamid.HBgLreplytarget', body: 'quoted words' })
    syncChat(
      storage,
      owner(),
      'c1',
      want({ draft: secret, draftChanged: true, sending: new Map([['d_x', secret]]) }),
      newKnown(),
    )
    const raw = [...storage.data.values()].join()
    for (const word of ['secret', 'quoted', 'replytarget']) expect(raw).not.toContain(word)
  })

  it('open only for their owner’s key and their own chat', () => {
    const storage = memory()
    const me = owner()
    syncChat(storage, me, 'c1', want({ draft: draft('hi'), draftChanged: true }), newKnown())
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
      sub: 'd_abc',
    })
    expect(keyOf('u1', 'trioditis.draftSent.u1.c1')).toMatchObject({ kind: 'draftSent', chatId: 'c1' })
    expect(keyOf('u2', savedDraftKey('u1', 'c1'))).toBeNull()
  })
})

describe('write before delete (I2)', () => {
  it('a send that didn’t go: its copy under way goes only once the draft it’s back in is saved', () => {
    const storage = memory()
    const me = owner()
    const known = newKnown()
    syncChat(storage, me, 'c1', want({ sending: new Map([['d_x', draft('hi', 's1')]]) }), known)
    // Back in the composer, but storage refuses: the copy under way stays, and it says so.
    storage.refuse = true
    const back = want({ draft: draft('hi', 's1'), draftChanged: true })
    expect(syncChat(storage, me, 'c1', back, known)).toBe(false)
    expect(loadAll(storage, me).sending).toHaveLength(1)
    // Once the draft is written, the copy under way goes.
    storage.refuse = false
    expect(syncChat(storage, me, 'c1', back, known)).toBe(true)
    const loaded = loadAll<Reply>(storage, me)
    expect(loaded.sending).toEqual([])
    expect(loaded.drafts.get('c1')?.text).toBe('hi')
  })

  it('a draft taken to send: its copy under way is written before the saved draft is cleared', () => {
    const storage = memory()
    const me = owner()
    const known = newKnown()
    syncChat(storage, me, 'c1', want({ draft: draft('hello', 'd1'), draftChanged: true }), known)
    // Taken to send: the composer is empty, the send under way. That one write is refused.
    storage.refuseKey = /draftSending/
    const taken = want({ draftChanged: true, sending: new Map([['d_hello', draft('hello', 'd1')]]) })
    expect(syncChat(storage, me, 'c1', taken, known)).toBe(false)
    // The saved draft is still there: nothing was cleared or replaced after the refused write.
    expect(loadAll(storage, me).drafts.get('c1')?.text).toBe('hello')
    // Also when something new was typed meanwhile: the saved draft isn't replaced either.
    const typed = want({ draft: draft('next', 'd2'), draftChanged: true, sending: taken.sending })
    expect(syncChat(storage, me, 'c1', typed, known)).toBe(false)
    expect(loadAll(storage, me).drafts.get('c1')?.text).toBe('hello')
    // Once it's written, the draft is cleared or replaced.
    storage.refuseKey = null
    expect(syncChat(storage, me, 'c1', typed, known)).toBe(true)
    const loaded = loadAll<Reply>(storage, me)
    expect(loaded.sending).toHaveLength(1)
    expect(loaded.drafts.get('c1')?.text).toBe('next')
  })

  it('takes a draft and notes its send under way in one change', () => {
    const a = chat()
    setDraftText(a, 'go')
    const seen: [string, number][] = []
    // What a save would see at each change: never an empty composer without the send noted.
    const stop = subscribeDrafts(() =>
      seen.push([getDraft(a).text, allSending().filter(([, p]) => p.chatId === a).length]),
    )
    const taken = takeForSend<Reply>(a, (t) => `d_${t.id}`)!
    stop()
    expect(seen).toEqual([['', 1]])
    endSend(taken.clientMessageId, true)
  })
})

describe('a tab that hasn’t seen another’s entries', () => {
  it('doesn’t erase another tab’s newer draft by typing and erasing', () => {
    const storage = memory()
    const me = owner()
    const a = newKnown()
    const b = newKnown()
    // B opened before A saved. A saves its draft.
    syncChat(storage, me, 'c1', want({ draft: draft('from A'), draftChanged: true }), a)
    // B types and erases in the same chat: A's draft stays.
    syncChat(storage, me, 'c1', want({ draftChanged: true }), b)
    expect(loadAll(storage, me).drafts.get('c1')?.text).toBe('from A')
    // A erasing its own does remove it.
    syncChat(storage, me, 'c1', want({ draftChanged: true }), a)
    expect(loadAll(storage, me).drafts.size).toBe(0)
  })
})

describe('the chat lock (I1)', () => {
  it('runs each change to a chat’s entries in its own lock, one at a time', async () => {
    const names: string[] = []
    let tail = Promise.resolve()
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, work: () => unknown) => {
          names.push(name)
          const run = tail.then(work)
          tail = run.then(() => undefined)
          return run
        },
      },
    })
    const order: string[] = []
    await Promise.all([
      withChatLock('u1', 'c1', async () => {
        order.push('a start')
        await new Promise((r) => setTimeout(r, 5))
        order.push('a end')
      }),
      withChatLock('u1', 'c1', () => void order.push('b')),
    ])
    expect(names).toEqual(['trioditis.drafts.u1.c1', 'trioditis.drafts.u1.c1'])
    expect(order).toEqual(['a start', 'a end', 'b'])
  })

  it('still runs where there are no Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    expect(await withChatLock('u1', 'c1', () => 7)).toBe(7)
  })
})

describe('a send under way', () => {
  it('is announced when it goes, apart from whatever the composer holds by then', () => {
    const a = chat()
    const heard: string[] = []
    const stop = onDraftSent((chatId, id) => heard.push(`${chatId}:${id}`))
    setDraftText(a, 'one')
    takeForSend<Reply>(a, () => 'd_one')
    // A new draft started while the first was on its way.
    setDraftText(a, 'two')
    endSend('d_one', true)
    stop()
    expect(heard).toEqual([`${a}:d_one`])
    expect(getDraft(a).text).toBe('two')
  })

  it('leaves a note other tabs and the next load read', () => {
    const storage = memory()
    syncChat(storage, owner(), 'c1', want({ sent: ['d_one'] }), newKnown())
    expect(parseSent(storage.getItem('trioditis.draftSent.u1.c1'))).toBe('d_one')
    expect(loadAll(storage, owner()).sent.get('c1')).toBe('d_one')
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
