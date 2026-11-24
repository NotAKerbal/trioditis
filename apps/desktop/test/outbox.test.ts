import { generateKeyPair, openJson, ready, toBase64Url, type Envelope } from '@trioditis/crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@trioditis/core'

// media.ts (for messageTypeOf) reaches for the Convex client and the session when it loads.
vi.mock('~/lib/convex.ts', () => ({ convex: { mutation: vi.fn() } }))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({}) }))

type OutboxModule = typeof import('../src/data/outbox.ts')
type DraftsModule = typeof import('../src/data/drafts.ts')
type FilesModule = typeof import('../src/features/chat/outgoing-files.ts')

let outboxMod: OutboxModule
let drafts: DraftsModule
let files: FilesModule

/** Loads the outbox and the stores it works on afresh, as a page load would. */
async function load() {
  outboxMod = await import('../src/data/outbox.ts')
  drafts = await import('../src/data/drafts.ts')
  files = await import('../src/features/chat/outgoing-files.ts')
}

const me = { userId: 'user-1', keyPair: undefined as unknown as ReturnType<typeof generateKeyPair> }
let bridgeKey = ''
let bridgePair: ReturnType<typeof generateKeyPair>

beforeAll(async () => {
  await ready()
  me.keyPair = generateKeyPair()
  bridgePair = generateKeyPair()
  bridgeKey = toBase64Url(bridgePair.publicKey)
  await load()
})

let n = 0
type ChatId = import('../src/data/chats.ts').ChatId
const chat = () => `chat-${++n}` as ChatId

type SendArgs = Parameters<import('../src/data/outbox.ts').OutboxPort['send']>[0]

/** A port that records what reaches the server, answering as each test says. */
function fakePort(over: Partial<import('../src/data/outbox.ts').OutboxPort> = {}) {
  const sent: SendArgs[] = []
  const uploaded: string[] = []
  const port = {
    send: vi.fn(async (args: SendArgs) => {
      sent.push(args)
      return 'queued' as const
    }),
    schedule: vi.fn(async () => 'scheduled-1' as never),
    sendAgain: vi.fn(async () => ({ created: true, state: {} as never })),
    upload: vi.fn(async (_chatId: string, file: File): Promise<Attachment> => {
      uploaded.push(file.name)
      return { mediaId: `m-${file.name}`, mime: file.type, size: file.size, name: file.name, key: 'k', nonce: 'n' }
    }),
    ...over,
  }
  return { port, sent, uploaded }
}

/** The outbox, with the bridge key, or (null) without one. */
const make = (port: import('../src/data/outbox.ts').OutboxPort, key: string | null = bridgeKey) =>
  outboxMod.outbox(port, { ...me, bridgeKey: key ?? undefined, bridgeStatus: key ? 'ready' : 'missing' })

/** The person's own copy of what was sent, opened as the chat would show it. */
const opened = (args: { copy: Envelope; clientMessageId: string }) =>
  openJson<{ type: string; body: string; attachments?: { name?: string }[] }>(args.copy, me.keyPair, {
    kind: 'message',
    ownerUserId: me.userId,
    objectId: args.clientMessageId,
  })

/** The part of a reply the send ID depends on. */
type Reply = { eventId: string }

const file = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'text/plain' })

/** A message in `chatId` to reply to. */
const message = (chatId: string, eventId: string) =>
  ({ chatId, eventId }) as unknown as import('../src/data/messages.ts').Message

describe('sending a draft', () => {
  it('seals the text, sends it under the draft’s own send ID, and empties the composer', async () => {
    const a = chat()
    drafts.setDraftText(a, 'hello')
    const expected = outboxMod.sendIdOf(drafts.getDraft<Reply>(a))
    const { port, sent } = fakePort()
    expect(await make(port).sendDraft(a)).toEqual({ kind: 'sent' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.clientMessageId).toBe(expected)
    expect(sent[0]).not.toHaveProperty('replyTo')
    expect(opened(sent[0]!)).toEqual({ type: 'text', body: 'hello' })
    // Only ciphertext reaches the server.
    expect(JSON.stringify(sent[0])).not.toContain('hello')
    expect(drafts.getDraft(a).text).toBe('')
    expect(drafts.allSending().some(([id]) => id === expected)).toBe(false)
  })

  it('drops a reply to a message in another chat, and keeps one in the same chat', async () => {
    const a = chat()
    const b = chat()
    const { port, sent } = fakePort()
    drafts.setDraftText(a, 'across')
    drafts.setDraftReply(a, message(b, '$elsewhere'))
    await make(port).sendDraft(a)
    expect(sent[0]).not.toHaveProperty('replyTo')
    drafts.setDraftText(a, 'here')
    drafts.setDraftReply(a, message(a, '$here'))
    await make(port).sendDraft(a)
    expect(sent[1]!.replyTo).toBe('$here')
  })

  it('puts a failed send back as the same draft, so sending it again is the same send', async () => {
    const a = chat()
    drafts.setDraftText(a, 'try me')
    drafts.setDraftReply(a, message(a, '$r'))
    const before = drafts.getDraft<Reply>(a)
    const failing = fakePort({
      send: vi.fn(async () => {
        throw new Error('Offline')
      }),
    })
    const outcome = await make(failing.port).sendDraft(a)
    expect(outcome).toEqual({ kind: 'failed', say: 'Offline' })
    const back = drafts.getDraft(a)
    expect(back).toMatchObject({ text: 'try me', id: before.id })
    expect(back.reply).toBe(before.reply)
    expect(drafts.allSending().some(([id]) => id === outboxMod.sendIdOf(before))).toBe(false)
    const { port, sent } = fakePort()
    await make(port).sendDraft(a)
    expect(sent[0]!.clientMessageId).toBe(outboxMod.sendIdOf(before))
  })

  it('settles a send whose ID was used already as the server says, never sending it again', async () => {
    const a = chat()
    drafts.setDraftText(a, 'twice?')
    const { port, sent } = fakePort({
      send: vi.fn(async () => ({ already: 'send' as const, delivery: 'failed' as const })),
    })
    const outcome = await make(port).sendDraft(a)
    expect(outcome).toMatchObject({ kind: 'used', action: 'again' })
    expect(sent).toHaveLength(0)
    expect(port.send).toHaveBeenCalledTimes(1)
    // It never went: back as a new draft, so sending it is a new message.
    expect(drafts.getDraft(a).text).toBe('twice?')
  })
})

describe('sending files', () => {
  it('sends each file with a message of its own, the caption and reply on the first only', async () => {
    const a = chat()
    drafts.setDraftText(a, 'look')
    drafts.setDraftReply(a, message(a, '$r'))
    const captionId = outboxMod.sendIdOf(drafts.getDraft<Reply>(a))
    files.addFiles(a, [file('a.txt'), file('b.txt')])
    const { port, sent } = fakePort()
    expect(await make(port).sendDraft(a)).toEqual({ kind: 'sent' })
    expect(sent.map((s) => s.clientMessageId)[0]).toBe(captionId)
    expect(sent.map((s) => s.replyTo)).toEqual(['$r', undefined])
    expect(sent.map((s) => opened(s).body)).toEqual(['look', 'b.txt'])
    expect(files.filesOf(a)).toEqual([])
    expect(drafts.getDraft<Reply>(a)).toMatchObject({ text: '', reply: null })
  })

  it('keeps files 2 and 3 when file 2 fails, with the caption’s send settled', async () => {
    const a = chat()
    drafts.setDraftText(a, 'three files')
    const captionId = outboxMod.sendIdOf(drafts.getDraft<Reply>(a))
    files.addFiles(a, [file('1.txt'), file('2.txt'), file('3.txt')])
    const went: string[] = []
    const stop = drafts.onDraftSent((_chat, id) => went.push(id))
    const base = fakePort()
    const { port, sent } = fakePort({
      upload: vi.fn(async (chatId: ChatId, f: File) => {
        if (f.name === '2.txt') throw new Error('The file couldn’t be sent (500).')
        return base.port.upload(chatId, f)
      }),
    })
    const outcome = await make(port).sendDraft(a)
    stop()
    expect(outcome).toEqual({ kind: 'failed', say: 'The file couldn’t be sent (500).' })
    expect(sent).toHaveLength(1)
    expect(files.filesOf(a).map((f) => [f.file.name, f.sending])).toEqual([
      ['2.txt', false],
      ['3.txt', false],
    ])
    // The caption went with file 1: it's settled, not back in the composer.
    expect(went).toEqual([captionId])
    expect(drafts.allSending().some(([id]) => id === captionId)).toBe(false)
    expect(drafts.getDraft(a).text).toBe('')
  })

  it('keeps every file when the caption’s send ID was used already', async () => {
    const a = chat()
    drafts.setDraftText(a, 'sent before the reload')
    files.addFiles(a, [file('1.txt'), file('2.txt'), file('3.txt')])
    const { port } = fakePort({
      send: vi.fn(async () => ({ already: 'send' as const, delivery: 'sent' as const })),
    })
    const outcome = await make(port).sendDraft(a)
    expect(outcome).toMatchObject({ kind: 'used', action: 'done' })
    expect(port.send).toHaveBeenCalledTimes(1)
    expect(files.filesOf(a).map((f) => [f.file.name, f.sending])).toEqual([
      ['1.txt', false],
      ['2.txt', false],
      ['3.txt', false],
    ])
    expect(drafts.getDraft(a).text).toBe('')
  })

  it('puts the caption back as the same draft when the first file fails', async () => {
    const a = chat()
    drafts.setDraftText(a, 'caption')
    const before = drafts.getDraft<Reply>(a)
    files.addFiles(a, [file('1.txt')])
    const { port } = fakePort({
      upload: vi.fn(async () => {
        throw new Error('Too large')
      }),
    })
    expect(await make(port).sendDraft(a)).toEqual({ kind: 'failed', say: 'Too large' })
    expect(drafts.getDraft<Reply>(a)).toMatchObject({ text: 'caption', id: before.id })
    expect(files.filesOf(a).map((f) => f.sending)).toEqual([false])
  })
})

describe('scheduling', () => {
  it('schedules the draft under its own send ID and says when', async () => {
    const a = chat()
    drafts.setDraftText(a, 'later')
    const id = outboxMod.sendIdOf(drafts.getDraft<Reply>(a))
    const { port } = fakePort()
    const at = Date.now() + 3_600_000
    const outcome = await make(port).schedule(a, at)
    expect(outcome.kind).toBe('scheduled')
    expect(outcome.say).toMatch(/^Scheduled for /)
    expect(port.schedule).toHaveBeenCalledWith(expect.objectContaining({ chatId: a, clientMessageId: id, sendAt: at }))
    expect(drafts.getDraft(a).text).toBe('')
  })

  it('takes nothing for a time over a year away', async () => {
    const a = chat()
    drafts.setDraftText(a, 'much later')
    const { port } = fakePort()
    const outcome = await make(port).schedule(a, Date.now() + 400 * 86_400_000)
    expect(outcome.kind).toBe('blocked')
    expect(port.schedule).not.toHaveBeenCalled()
    expect(drafts.getDraft(a).text).toBe('much later')
  })
})

describe('without a bridge key', () => {
  it('sends nothing, takes nothing, and says the one message wherever a send starts', async () => {
    const a = chat()
    drafts.setDraftText(a, 'waiting')
    files.addFiles(a, [file('1.txt')])
    const { port } = fakePort()
    const box = make(port, null)
    const say = outboxMod.noBridgeKey('missing')
    expect(await box.sendDraft(a)).toEqual({ kind: 'blocked', say })
    expect(await box.schedule(a, Date.now() + 60_000)).toEqual({ kind: 'blocked', say })
    const failed = { body: { type: 'text' as const, body: 'again' }, clientMessageId: 'c1', replyTo: undefined }
    const state = { root: 'c1', latest: 'c1', delivery: 'failed', allowed: true, nextId: 'c2' }
    expect(await box.sendAgain(failed, state)).toEqual({ kind: 'blocked', say })
    for (const call of [port.send, port.schedule, port.sendAgain, port.upload]) expect(call).not.toHaveBeenCalled()
    expect(drafts.getDraft(a).text).toBe('waiting')
    expect(files.filesOf(a).map((f) => f.sending)).toEqual([false])
  })

  it('says to wait while the key is still loading, and to reload when it couldn’t be', async () => {
    const a = chat()
    drafts.setDraftText(a, 'soon')
    const { port } = fakePort()
    const loading = outboxMod.outbox(port, { ...me, bridgeKey: undefined, bridgeStatus: 'loading' })
    expect(await loading.sendDraft(a)).toEqual({
      kind: 'blocked',
      say: 'Still connecting to the server. Try again in a moment.',
    })
    const failed = outboxMod.outbox(port, { ...me, bridgeKey: undefined, bridgeStatus: 'error' })
    expect(await failed.schedule(a, Date.now() + 60_000)).toEqual({
      kind: 'blocked',
      say: 'The server’s bridge key couldn’t be loaded, so nothing can be sent. Reload to try again.',
    })
    expect(await make(port, null).sendDraft(a)).toEqual({
      kind: 'blocked',
      say: 'This server has no bridge key yet, so nothing can be sent.',
    })
    expect(drafts.getDraft(a).text).toBe('soon')
  })

  it('puts a text back without a word when the bridge key won’t parse', async () => {
    const a = chat()
    drafts.setDraftText(a, 'unsealable')
    const before = drafts.getDraft<Reply>(a)
    const { port } = fakePort()
    expect(await make(port, '!not a key!').sendDraft(a)).toEqual({ kind: 'failed' })
    expect(port.send).not.toHaveBeenCalled()
    expect(drafts.getDraft(a)).toMatchObject({ text: 'unsealable', id: before.id })
    expect(drafts.allSending().some(([id]) => id === outboxMod.sendIdOf(before))).toBe(false)
  })
})

describe('sending again', () => {
  it('seals the next attempt for its own ID, with the file as it was', async () => {
    let args: (SendArgs & { nextId: string }) | undefined
    const { port } = fakePort({
      sendAgain: vi.fn(async (a: SendArgs & { nextId: string }) => {
        args = a
        return { created: true, state: {} as never }
      }) as never,
    })
    const attachment = { mediaId: 'm1', mime: 'image/png', size: 3, key: 'k', nonce: 'n' }
    const failed = {
      body: { type: 'image' as const, body: 'pic', attachments: [attachment] },
      clientMessageId: 'c1',
      replyTo: '$r',
    }
    const state = { root: 'c1', latest: 'c1', delivery: 'failed', allowed: true, nextId: 'c2' }
    expect(await make(port).sendAgain(failed, state)).toEqual({ kind: 'sent' })
    expect(args).toMatchObject({ clientMessageId: 'c1', nextId: 'c2', replyTo: '$r' })
    expect(opened({ copy: args!.copy, clientMessageId: 'c2' })).toEqual(failed.body)
  })

  it('says so when the server declines the attempt', async () => {
    const { port } = fakePort({ sendAgain: vi.fn(async () => ({ created: false, state: {} as never })) })
    const failed = { body: { type: 'text' as const, body: 'x' }, clientMessageId: 'c1', replyTo: undefined }
    const state = { root: 'c1', latest: 'c1', delivery: 'unknown', allowed: true, nextId: 'c2' }
    expect(await make(port).sendAgain(failed, state)).toEqual({
      kind: 'declined',
      say: 'That message was sent again already, or can’t be now.',
    })
  })
})

describe('restoring a cancelled message', () => {
  it('fills an empty draft, and refuses one replying elsewhere', () => {
    const a = chat()
    const { port } = fakePort()
    const box = make(port)
    expect(box.restoreCancelled(a, 'back', '$r', message(a, '$r'))).toEqual({ kind: 'restored', added: false })
    expect(drafts.getDraft(a).text).toBe('back')
    expect(box.restoreCancelled(a, 'other', null, null)).toEqual({
      kind: 'conflict',
      say: 'Clear or send your draft first.',
    })
  })
})
