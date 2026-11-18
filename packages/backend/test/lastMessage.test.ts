import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { byteSize } from '../convex/lib/bounded'
import { chatViewOf } from '../convex/lib/chatView'
import { MAX_PREVIEW_SEALED_BYTES, lastOf } from '../convex/lib/lastMessage'
import { GATEWAY_SECRET, sealed, setup, signIn, type T } from './setup'

// Each chat row's `lastMessage`, kept as a pointer on the chat by every write that changes
// which message is the newest or what it says.

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }
const first = { numItems: 50, cursor: null }

afterEach(() => {
  vi.useRealTimers()
})

let seq = 0
const event = (type: string, fields: Record<string, unknown>) => ({
  userId: 'user_a',
  loginId: 'login_a',
  at: 1_000,
  seq: ++seq,
  type,
  ...fields,
})

/** An event in the chat. */
const inChat = (type: string, fields: Record<string, unknown>) => event(type, { portalId: 'portal_1', ...fields })

const message = (eventId: string, networkTs: number, fields: Record<string, unknown> = {}) =>
  inChat('message', {
    eventId,
    networkTs,
    sender: { ghostId: 'ghost_1' },
    sealed: sealed(eventId),
    historical: false,
    ...fields,
  })

async function ingest(t: T, events: unknown[]) {
  return await t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, ...HOST, events: events as never })
}

async function ready() {
  seq = 0
  const t = setup()
  const a = await signIn(t, 'user_a')
  // The person's login runs on the host the events come from.
  await ingest(t, [event('loginState', { state: 'CONNECTED' })])
  return { t, a }
}

async function row(a: Awaited<ReturnType<typeof signIn>>) {
  const { page } = await a.query(api.chats.list, { paginationOpts: first })
  expect(page).toHaveLength(1)
  return page[0]!
}

async function messageId(t: T, eventId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query('messages')
      .withIndex('by_event', (q) => q.eq('userId', 'user_a').eq('network', 'whatsapp').eq('eventId', eventId))
      .unique()
    return row!._id
  })
}

/** An envelope that takes exactly `bytes` stored, or one byte less where base64 can't. */
function envelopeOf(bytes: number) {
  const shape = { ...sealed('big'), ct: '' }
  let length = bytes - byteSize(shape)
  // Unpadded base64 is never one more than a multiple of four characters long.
  if (length % 4 === 1) length -= 1
  return { ...shape, ct: 'A'.repeat(length) }
}

const id = (n: number) => `client-message-${String(n).padStart(4, '0')}`

describe('a chat’s last message', () => {
  it('points at a new message, with what opens it and who sent it', async () => {
    const { t, a } = await ready()
    expect((await t.run(async (ctx) => await ctx.db.query('chats').collect())).length).toBe(0)
    await ingest(t, [message('e1', 2_000)])
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'e1'),
      at: 2_000,
      self: false,
      ghostId: 'ghost_1',
      redacted: false,
      sealed: sealed('e1'),
      objectId: 'e1',
    })
    await ingest(t, [message('e2', 3_000, { sender: { self: true } })])
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'e2'),
      at: 3_000,
      self: true,
      redacted: false,
      sealed: sealed('e2'),
      objectId: 'e2',
    })
  })

  it('matches the first message `messages.list` returns, and how it opens there', async () => {
    const { t, a } = await ready()
    await ingest(t, [message('e1', 2_000), message('e2', 3_000)])
    await ingest(t, [
      inChat('edit', {
        eventId: 'edit1',
        targetEventId: 'e2',
        networkTs: 3_500,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed('edit1'),
      }),
    ])
    const last = (await row(a)).lastMessage!
    const { page } = await a.query(api.messages.list, { chatId: (await row(a))._id, paginationOpts: first })
    const top = page[0]!
    expect(last.messageId).toBe(top._id)
    expect(last.at).toBe(top.networkTs)
    expect(last.sealed).toEqual(top.sealedEdit ?? top.sealed)
    expect(last.objectId).toBe(top.sealedEdit ? top.editEventId : top.sealedObjectId)
    expect(last.self).toBe('self' in top.sender)
    expect(last.ghostId).toBe('ghostId' in top.sender ? top.sender.ghostId : undefined)
  })

  it('never lets an older message that arrives later take the place of a newer one', async () => {
    const { t, a } = await ready()
    await ingest(t, [message('late', 9_000), message('early', 1_000)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'late', at: 9_000 })
    await ingest(t, [message('earlier', 500), message('also-early', 8_999, { historical: true })])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'late', at: 9_000 })
    await ingest(t, [message('later', 9_001)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'later', at: 9_001 })
  })

  it('takes an edit of the newest message, and ignores an edit of an older one', async () => {
    const { t, a } = await ready()
    await ingest(t, [message('e1', 2_000), message('e2', 3_000)])
    const edit = (eventId: string, targetEventId: string, networkTs: number) =>
      inChat('edit', { eventId, targetEventId, networkTs, sender: { ghostId: 'ghost_1' }, sealed: sealed(eventId) })
    await ingest(t, [edit('edit-old', 'e1', 4_000)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'e2', sealed: sealed('e2') })
    await ingest(t, [edit('edit-new', 'e2', 4_000)])
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'e2'),
      at: 3_000,
      self: false,
      ghostId: 'ghost_1',
      redacted: false,
      sealed: sealed('edit-new'),
      objectId: 'edit-new',
    })
    // An edit older than the one it has changes nothing, here as on the message.
    await ingest(t, [edit('edit-stale', 'e2', 3_900)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'edit-new' })
  })

  it('shows a deleted newest message as deleted, without its content', async () => {
    const { t, a } = await ready()
    await ingest(t, [message('e1', 2_000), message('e2', 3_000)])
    await ingest(t, [
      inChat('edit', {
        eventId: 'edit1',
        targetEventId: 'e2',
        networkTs: 3_100,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed('edit1'),
      }),
      inChat('redaction', { targetEventId: 'e2', networkTs: 3_200, sender: { ghostId: 'ghost_1' } }),
    ])
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'e2'),
      at: 3_000,
      self: false,
      ghostId: 'ghost_1',
      redacted: true,
      sealed: null,
      objectId: 'e2',
    })
    // Deleting an older one leaves it alone.
    await ingest(t, [inChat('redaction', { targetEventId: 'e1', networkTs: 3_300, sender: { ghostId: 'ghost_1' } })])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'e2', redacted: true })
  })

  it('carries only an envelope of 4 KiB or less, and everything else either way', async () => {
    const { t, a } = await ready()
    const atCap = envelopeOf(MAX_PREVIEW_SEALED_BYTES)
    const over = envelopeOf(MAX_PREVIEW_SEALED_BYTES + 2)
    expect(byteSize(atCap)).toBeLessThanOrEqual(MAX_PREVIEW_SEALED_BYTES)
    expect(byteSize(atCap)).toBeGreaterThan(MAX_PREVIEW_SEALED_BYTES - 2)
    expect(byteSize(over)).toBeGreaterThan(MAX_PREVIEW_SEALED_BYTES)
    expect(byteSize(over)).toBeLessThan(MAX_PREVIEW_SEALED_BYTES + 3)
    await ingest(t, [message('small', 2_000, { sealed: atCap })])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'small', sealed: atCap })
    await ingest(t, [message('big', 3_000, { sealed: over })])
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'big'),
      at: 3_000,
      self: false,
      ghostId: 'ghost_1',
      redacted: false,
      sealed: null,
      objectId: 'big',
    })
    // The message itself keeps all of it.
    const bigId = await messageId(t, 'big')
    const stored = await t.run(async (ctx) => await ctx.db.get(bigId))
    expect(stored!.sealed).toEqual(over)
    // An edit that is too big leaves the preview out too, and still names the edit.
    await ingest(t, [
      inChat('edit', {
        eventId: 'edit-big',
        targetEventId: 'small',
        networkTs: 4_000,
        sender: { ghostId: 'ghost_1' },
        sealed: over,
      }),
    ])
    await ingest(t, [message('newest', 5_000)])
    await ingest(t, [
      inChat('edit', {
        eventId: 'edit-newest',
        targetEventId: 'newest',
        networkTs: 6_000,
        sender: { ghostId: 'ghost_1' },
        sealed: over,
      }),
    ])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'edit-newest', sealed: null, redacted: false })
  })
})

describe('a chat’s last message, for the person’s own sends', () => {
  // A send's pending copy is timed by the clock, so the other messages are timed from it.
  const before = Date.now() - 60_000

  async function chatWithSends() {
    const { t, a } = await ready()
    await ingest(t, [message('before', before)])
    const chatId = (await row(a))._id
    return { t, a, chatId }
  }

  async function sentAt(a: Awaited<ReturnType<typeof signIn>>) {
    return (await row(a)).lastMessage!.at
  }

  async function send(a: Awaited<ReturnType<typeof signIn>>, chatId: Id<'chats'>, n: number) {
    await a.mutation(api.messages.send, {
      chatId,
      clientMessageId: id(n),
      forBridge: sealed(`b${n}`),
      copy: sealed(`c${n}`),
    })
  }

  async function claim(t: T) {
    return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 10, hostIds: [HOST.hostId] })
  }

  const echo = (n: number, eventId: string, networkTs: number) =>
    message(eventId, networkTs, { sender: { self: true }, sealed: sealed(eventId), clientMessageId: id(n) })

  it('points at a pending send, then at its echo, which keeps its ID', async () => {
    const { t, a, chatId } = await chatWithSends()
    await send(a, chatId, 1)
    const pendingId = (await row(a)).lastMessage!.messageId
    const at = await sentAt(a)
    expect(at).toBeGreaterThan(before)
    expect((await row(a)).lastMessage).toEqual({
      messageId: pendingId,
      at,
      self: true,
      redacted: false,
      sealed: sealed('c1'),
      objectId: id(1),
    })
    await claim(t)
    await ingest(t, [echo(1, 'net_1', at + 50)])
    expect((await row(a)).lastMessage).toEqual({
      messageId: pendingId,
      at: at + 50,
      self: true,
      redacted: false,
      sealed: sealed('net_1'),
      objectId: 'net_1',
    })
  })

  it('falls back to the newest other message when an echo’s network time puts it lower', async () => {
    const { t, a, chatId } = await chatWithSends()
    await send(a, chatId, 1)
    await claim(t)
    // The network timed the send before a message that was already here.
    await ingest(t, [echo(1, 'net_1', before - 1_000)])
    expect((await row(a)).lastMessage).toMatchObject({ messageId: await messageId(t, 'before'), objectId: 'before' })
  })

  it('takes an echo that is now the newest when it pointed elsewhere', async () => {
    const { t, a, chatId } = await chatWithSends()
    await send(a, chatId, 1)
    const at = await sentAt(a)
    await claim(t)
    await ingest(t, [message('meanwhile', at + 10)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'meanwhile' })
    await ingest(t, [echo(1, 'net_1', at + 20)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'net_1', at: at + 20, self: true })
  })

  it('falls back to the message before a discarded send', async () => {
    const { t, a, chatId } = await chatWithSends()
    await send(a, chatId, 1)
    await claim(t)
    await ingest(t, [event('sendStatus', { clientMessageId: id(1), status: 'unknown' })])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: id(1) })
    await a.mutation(api.messages.discardSend, { clientMessageId: id(1) })
    expect((await row(a)).lastMessage).toEqual({
      messageId: await messageId(t, 'before'),
      at: before,
      self: false,
      ghostId: 'ghost_1',
      redacted: false,
      sealed: sealed('before'),
      objectId: 'before',
    })
  })

  it('is null once a chat’s only message is discarded', async () => {
    const { t, a } = await ready()
    const chatId = await t.run(async (ctx) => {
      const fields = {
        userId: 'user_a',
        network: 'whatsapp' as const,
        loginId: 'login_a',
        portalId: 'portal_1',
        kind: 'dm' as const,
        lastMessageAt: 0,
        last: null,
        unreadCount: 0,
        pinned: false,
        archived: false,
      }
      return await ctx.db.insert('chats', { ...fields, view: chatViewOf(fields) })
    })
    await send(a, chatId, 1)
    await claim(t)
    await ingest(t, [event('sendStatus', { clientMessageId: id(1), status: 'failed' })])
    await a.mutation(api.messages.discardSend, { clientMessageId: id(1) })
    expect((await row(a)).lastMessage).toBeNull()
  })
})

/** A chat as a version from before the pointer left it: no `last`. */
async function olderChat(t: T, portalId: string, fields: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const row = {
      userId: 'user_a',
      network: 'whatsapp' as const,
      loginId: 'login_a',
      portalId,
      kind: 'dm' as const,
      lastMessageAt: 0,
      unreadCount: 0,
      pinned: false,
      archived: false,
      ...fields,
    }
    return await ctx.db.insert('chats', { ...row, view: chatViewOf(row) })
  })
}

async function olderMessage(t: T, chatId: Id<'chats'>, eventId: string, ts: number) {
  await t.run(async (ctx) => {
    await ctx.db.insert('messages', {
      userId: 'user_a',
      chatId,
      network: 'whatsapp',
      eventId,
      networkTs: ts,
      sortKey: `${String(ts).padStart(16, '0')}:${eventId}`,
      sender: { ghostId: 'g' },
      sealed: sealed(eventId),
      sealedObjectId: eventId,
      historical: false,
    })
  })
}

describe('the last-message backfill', () => {
  it('gives every older chat its pointer, and running it again changes nothing', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    // More than a batch, so it carries on through scheduled runs.
    const chats: Id<'chats'>[] = []
    for (let n = 0; n < 25; n++) {
      const chatId = await olderChat(t, `c${n}`, { lastMessageAt: n })
      chats.push(chatId)
      if (n === 0) continue
      await olderMessage(t, chatId, `c${n}-new`, 2_000 + n)
      await olderMessage(t, chatId, `c${n}-old`, 1_000 + n)
    }
    // Before it runs, an older chat has no preview to show.
    expect(
      (await a.query(api.chats.list, { paginationOpts: first })).page.every((row) => row.lastMessage === null),
    ).toBe(true)

    // Through the entry point pnpm dev and the installer call.
    await t.action(internal.migrations.runAll, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const after = await t.run(async (ctx) => await ctx.db.query('chats').collect())
    expect(after.find((chat) => chat._id === chats[0])!.last).toBeNull()
    for (let n = 1; n < 25; n++) {
      const chat = after.find((row) => row._id === chats[n])!
      const newestId = await messageId(t, `c${n}-new`)
      const newest = await t.run(async (ctx) => (await ctx.db.get(newestId))!)
      expect(chat.last).toEqual(lastOf(newest))
    }
    const { page } = await a.query(api.chats.list, { paginationOpts: first })
    expect(page.find((row) => row.portalId === 'c7')!.lastMessage).toMatchObject({ objectId: 'c7-new', at: 2_007 })

    // A pointer it finds is left as it is, even one it would have worked out differently.
    const untouched = { ...after.find((chat) => chat._id === chats[3])!.last!, objectId: 'kept' }
    await t.run(async (ctx) => await ctx.db.patch(chats[3]!, { last: untouched }))
    const before = await t.run(async (ctx) => await ctx.db.query('chats').collect())
    await t.mutation(internal.migrations.backfillChatLast, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run(async (ctx) => await ctx.db.query('chats').collect())).toEqual(before)
  })

  it('works out an older chat’s pointer when a message arrives before the backfill', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await olderChat(t, 'portal_1')
    await olderMessage(t, chatId, 'stored', 5_000)
    // An older message arriving first doesn't become the preview.
    await ingest(t, [message('arrived', 1_000)])
    expect((await row(a)).lastMessage).toMatchObject({ objectId: 'stored', at: 5_000 })
  })
})

describe('the chat list’s byte budget', () => {
  it('fits a full page of rows that each carry the largest metadata and preview', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    // Sealed metadata at its 8 KiB cap with eight keys, and a preview just under 4 KiB.
    const key = sealed('k').keys[0]!
    const meta = { ...sealed('meta'), ct: 'A'.repeat(Math.ceil((8 * 1024 * 4) / 3)), keys: Array(8).fill(key) }
    const preview = envelopeOf(MAX_PREVIEW_SEALED_BYTES)
    const longId = 'x'.repeat(256)
    for (let n = 0; n < 60; n++) {
      const chatId = await olderChat(t, `${longId.slice(4)}${String(n).padStart(4, '0')}`, {
        lastMessageAt: n,
        sealedMeta: meta,
        loginId: longId,
        parentPortalId: longId,
      })
      await t.run(async (ctx) => {
        const messageId = await ctx.db.insert('messages', {
          userId: 'user_a',
          chatId,
          network: 'whatsapp',
          eventId: longId,
          networkTs: n,
          sortKey: `${String(n).padStart(16, '0')}:${longId}`,
          sender: { ghostId: longId },
          sealed: preview,
          sealedObjectId: longId,
          historical: false,
        })
        await ctx.db.patch(chatId, { last: lastOf((await ctx.db.get(messageId))!) })
      })
    }
    const rows = await t.run(async (ctx) => await ctx.db.query('chats').collect())
    const largest = Math.max(...rows.map((row) => byteSize(row)))
    expect(rows[0]!.last!.sealed).toEqual(preview)
    // Each row is under 20 KiB, so 51 of them (the most a page reads) are about 1 MiB, far
    // inside the 8 MiB a page may read.
    expect(largest).toBeLessThan(20 * 1024)
    expect(51 * largest).toBeLessThan((8 * 1024 * 1024) / 4)

    const page = await a.query(api.chats.list, { paginationOpts: first })
    expect(page.page).toHaveLength(50)
    expect(page.pageStatus).not.toBe('SplitRequired')
    expect(page.page.every((row) => row.lastMessage?.sealed !== null)).toBe(true)
    const next = await a.query(api.chats.list, { paginationOpts: { numItems: 50, cursor: page.continueCursor } })
    expect(next.page).toHaveLength(10)
  })
})
