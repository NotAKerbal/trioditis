import { generateKeyPair, ready } from '@trioditis/crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  adoptDraft,
  allHeld,
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
  keyOf,
  loadAll,
  newKnown,
  parseSent,
  savedDraftKey,
  syncChat,
  withChatLock,
  writeHeld,
  type ChatKnown,
  type ChatWant,
  type DraftStorage,
} from '../src/data/saved-drafts.ts'

beforeAll(ready)
afterEach(() => vi.unstubAllGlobals())

/** Storage two tabs share; `refuse` makes every write fail, as a full one does. */
function memory(): DraftStorage & { data: Map<string, string>; refuse: boolean } {
  const data = new Map<string, string>()
  const store = {
    data,
    refuse: false,
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (store.refuse) throw new Error('quota')
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
  held: [],
  sending: new Map(),
  sent: [],
  ...w,
})
let n = 0
const chat = () => `chat-${++n}`

describe('drafts saved across a reload', () => {
  it('come back after a reload: draft, held messages and sends under way, each with its identity', () => {
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
        held: [draft('held one', 'h1')],
        sending: new Map([['d_s', draft('on its way', 's1')]]),
      }),
      known,
    )
    const loaded = loadAll<Reply>(storage, me)
    expect(loaded.drafts.get('c1')).toMatchObject(draft('see you at 7', 'id-1', { eventId: 'e1', body: 'when?' }))
    expect(loaded.held).toEqual([{ chatId: 'c1', copy: draft('held one', 'h1') }])
    expect(loaded.sending).toEqual([{ chatId: 'c1', sendId: 'd_s', copy: draft('on its way', 's1') }])
  })

  it('are stored sealed: no text, reply or plaintext of any kind on disk', () => {
    const storage = memory()
    const secret = draft('the secret plan', 'id-1', { eventId: 'wamid.HBgLreplytarget', body: 'quoted words' })
    syncChat(
      storage,
      owner(),
      'c1',
      want({ draft: secret, draftChanged: true, held: [{ ...secret, id: 'h1' }], sending: new Map([['d_x', secret]]) }),
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
    expect(keyOf('u1', 'trioditis.draftHeld.u1.c1.h1')).toEqual({ kind: 'draftHeld', chatId: 'c1', sub: 'h1' })
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

  it('a held message going into the composer: its held copy goes only once the draft is saved', () => {
    const storage = memory()
    const me = owner()
    const known = newKnown()
    syncChat(storage, me, 'c1', want({ held: [draft('held', 'h1')] }), known)
    storage.refuse = true
    const promoted = want({ draft: draft('held', 'h1'), draftChanged: true })
    expect(syncChat(storage, me, 'c1', promoted, known)).toBe(false)
    expect(loadAll(storage, me).held).toHaveLength(1)
    storage.refuse = false
    syncChat(storage, me, 'c1', promoted, known)
    expect(loadAll(storage, me).held).toEqual([])
    expect(loadAll(storage, me).drafts.get('c1')?.id).toBe('h1')
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

  it('doesn’t erase another tab’s held message, one key per message', () => {
    const storage = memory()
    const me = owner()
    const a = newKnown()
    const b: ChatKnown = newKnown()
    syncChat(storage, me, 'c1', want({ held: [draft('A’s', 'h1')] }), a)
    // B holds and releases its own; A's stays.
    syncChat(storage, me, 'c1', want({ held: [draft('B’s', 'h2')] }), b)
    syncChat(storage, me, 'c1', want(), b)
    expect(loadAll(storage, me).held.map((h) => h.copy.id)).toEqual(['h1'])
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

describe('a held message', () => {
  it('waits for the composer to be free, never joining a draft that replies elsewhere', () => {
    const a = chat()
    setDraftReply(a, { eventId: 'e2', body: 'other' })
    setDraftText(a, 'my reply to e2')
    holdDraft<Reply>(a, { text: 'cancelled', reply: { eventId: 'e1', body: 'q' } })
    expect(getDraft(a).text).toBe('my reply to e2')
    expect(allHeld()).toMatchObject([
      [a, [{ text: 'cancelled', reply: { eventId: 'e1', body: 'q' }, id: expect.any(String) }]],
    ])
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

  it('gets its identity when it’s held, so two tabs loading it send it as one message', () => {
    // A cancelled message held with no identity of its own, behind a draft that replies elsewhere.
    const a = chat()
    setDraftText(a, 'busy')
    holdDraft<Reply>(a, { text: 'cancelled', reply: null })
    const [, list] = allHeld<Reply>().find(([c]) => c === a)!
    expect(list[0]!.id).toMatch(/\S/)
    // Saved, then loaded by two tabs.
    const storage = memory()
    const me = owner()
    writeHeld(storage, me, a, { ...list[0]!, id: list[0]!.id! })
    const tab1 = loadAll<Reply>(storage, me).held[0]!.copy
    const tab2 = loadAll<Reply>(storage, me).held[0]!.copy
    // Each tab puts it in an empty composer and sends it: the same send ID, so the server dedupes.
    const b = chat()
    const c = chat()
    holdDraft(b, tab1)
    holdDraft(c, tab2)
    expect(draftSendId(getDraft(b).id, getDraft(b).text, undefined)).toBe(
      draftSendId(getDraft(c).id, getDraft(c).text, undefined),
    )
  })
})
