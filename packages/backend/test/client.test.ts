import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { chatViewOf } from '../convex/lib/chatView'
import { GATEWAY_SECRET, heartbeat, sealed, setup, signIn, type T, installNetworks } from './setup'

afterEach(() => {
  vi.useRealTimers()
})

const first = { numItems: 50, cursor: null }

async function aChat(t: T, userId: string, portalId: string, fields: Record<string, unknown> = {}) {
  return await t.run(async (ctx) => {
    const row = {
      userId,
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

async function aMessage(t: T, chatId: Id<'chats'>, eventId: string, ts: number, fields: Record<string, unknown> = {}) {
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
      ...fields,
    })
  })
}

const id = (n: number) => `client-message-${String(n).padStart(4, '0')}`

type View = 'inbox' | 'archived' | 'snoozed' | 'requests' | 'blocked'

describe('chat views', () => {
  it('puts each chat in exactly one view, by precedence', () => {
    const soon = Date.now() + 60_000
    expect(chatViewOf({ blocked: true, isRequest: true, snoozedUntil: soon, archived: true })).toBe('blocked')
    expect(chatViewOf({ isRequest: true, snoozedUntil: soon, archived: true })).toBe('requests')
    expect(chatViewOf({ snoozedUntil: soon, woke: false, archived: true })).toBe('snoozed')
    expect(chatViewOf({ snoozedUntil: soon, woke: true, archived: true })).toBe('archived')
    expect(chatViewOf({ snoozedUntil: soon, woke: true })).toBe('inbox')
    expect(chatViewOf({ archived: true })).toBe('archived')
    expect(chatViewOf({ deleted: true, archived: true })).toBe('deleted')
  })

  it('lists pinned chats first, then by recency, a page at a time', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    for (let n = 1; n <= 7; n++) await aChat(t, 'user_a', `c${n}`, { lastMessageAt: n })
    await aChat(t, 'user_a', 'pinned', { lastMessageAt: 0, pinned: true })
    await aChat(t, 'user_a', 'archived', { lastMessageAt: 9, archived: true })
    const page1 = await a.query(api.chats.list, { paginationOpts: { numItems: 3, cursor: null } })
    expect(page1.page.map((row) => row.portalId)).toEqual(['pinned', 'c7', 'c6'])
    const page2 = await a.query(api.chats.list, { paginationOpts: { numItems: 3, cursor: page1.continueCursor } })
    expect(page2.page.map((row) => row.portalId)).toEqual(['c5', 'c4', 'c3'])
    expect(
      (await a.query(api.chats.list, { view: 'archived', paginationOpts: first })).page.map((row) => row.portalId),
    ).toEqual(['archived'])
    const [row] = page1.page
    expect(row).toMatchObject({
      mentionCount: 0,
      markedUnread: false,
      woke: false,
      isRequest: false,
      labelIds: [],
      networkAccountId: null,
    })
  })

  it('carries pins past a page on to the next, and filters by network from one range', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    for (let n = 0; n < 55; n++) await aChat(t, 'user_a', `pin${n}`, { lastMessageAt: n, pinned: true })
    await aChat(t, 'user_a', 'plain', { lastMessageAt: 100 })
    await aChat(t, 'user_a', 'signal-pin', { lastMessageAt: 200, pinned: true, network: 'signal' })
    await aChat(t, 'user_a', 'signal-plain', { lastMessageAt: 300, network: 'signal' })
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const result: { page: { portalId: string }[]; isDone: boolean; continueCursor: string } = await a.query(
        api.chats.list,
        { network: 'whatsapp', paginationOpts: { numItems: 50, cursor } },
      )
      seen.push(...result.page.map((row) => row.portalId))
      if (result.isDone) break
      cursor = result.continueCursor
    }
    expect(seen).toEqual([...Array.from({ length: 55 }, (_, n) => `pin${54 - n}`), 'plain'])
    const signal = await a.query(api.chats.list, { network: 'signal', paginationOpts: first })
    expect(signal.page.map((row) => row.portalId)).toEqual(['signal-pin', 'signal-plain'])
  })

  it('lists by recency alone, pinned or not, when asked', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    for (let n = 1; n <= 4; n++) await aChat(t, 'user_a', `c${n}`, { lastMessageAt: n * 10 })
    await aChat(t, 'user_a', 'old-pin', { lastMessageAt: 5, pinned: true })
    await aChat(t, 'user_a', 'new-pin', { lastMessageAt: 35, pinned: true })
    await aChat(t, 'user_a', 'signal', { lastMessageAt: 99, network: 'signal' })
    const page1 = await a.query(api.chats.list, {
      order: 'recent',
      network: 'whatsapp',
      paginationOpts: { numItems: 3, cursor: null },
    })
    expect(page1.page.map((row) => row.portalId)).toEqual(['c4', 'new-pin', 'c3'])
    const page2 = await a.query(api.chats.list, {
      order: 'recent',
      network: 'whatsapp',
      paginationOpts: { numItems: 3, cursor: page1.continueCursor },
    })
    expect(page2.page.map((row) => row.portalId)).toEqual(['c2', 'c1', 'old-pin'])
    const all = await a.query(api.chats.list, { order: 'recent', paginationOpts: first })
    expect(all.page.map((row) => row.portalId)).toEqual(['signal', 'c4', 'new-pin', 'c3', 'c2', 'c1', 'old-pin'])
  })

  it('moves a chat between views as its flags change, including combined ones', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const viewOf = async () => {
      for (const view of ['inbox', 'archived', 'snoozed', 'requests', 'blocked'] as View[]) {
        const { page } = await a.query(api.chats.list, { view, paginationOpts: first })
        if (page.some((row) => row._id === chatId)) return view
      }
      return null
    }
    await a.mutation(api.chats.setArchived, { chatId, archived: true })
    expect(await viewOf()).toBe('archived')
    await a.mutation(api.chats.snooze, { chatId, until: Date.now() + 60_000 })
    expect(await viewOf()).toBe('snoozed')
    await a.mutation(api.chats.setBlocked, { chatId, blocked: true })
    expect(await viewOf()).toBe('blocked')
    await a.mutation(api.chats.setBlocked, { chatId, blocked: false })
    // The snooze ends: the chat comes back to the inbox, unarchived.
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    expect(await viewOf()).toBe('inbox')
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ woke: true, archived: false })
  })

  it('counts badges from bounded ranges, capped at 99', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    for (let n = 0; n < 105; n++) await aChat(t, 'user_a', `u${n}`, { unreadCount: 1, lastMessageAt: n })
    await aChat(t, 'user_a', 'muted', { unreadCount: 3, mutedUntil: Number.MAX_SAFE_INTEGER })
    await aChat(t, 'user_a', 'req', { isRequest: true })
    expect(await a.query(api.chats.counts, {})).toEqual({
      inbox: { count: 99, more: true },
      requests: { count: 1, more: false },
      woke: { count: 0, more: false },
    })
  })

  it('shows each person only their own chats', async () => {
    const t = setup()
    await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    expect((await b.query(api.chats.list, { paginationOpts: first })).page).toHaveLength(0)
    const call = b.mutation as (fn: unknown, args: unknown) => Promise<unknown>
    for (const [fn, extra] of [
      [api.chats.markRead, {}],
      [api.chats.markUnread, {}],
      [api.chats.setArchived, { archived: true }],
      [api.chats.setPinned, { pinned: true }],
      [api.chats.setMuted, { muted: true }],
      [api.chats.snooze, { until: Date.now() + 60_000 }],
      [api.chats.wake, {}],
      [api.chats.acceptRequest, {}],
      [api.chats.setBlocked, { blocked: true }],
      [api.chats.setLabels, { labelIds: [] }],
    ] as const) {
      await expect(call(fn, { chatId, ...extra })).rejects.toThrow(/doesn’t exist/)
    }
    await expect(b.query(api.chats.get, { chatId })).rejects.toThrow(/doesn’t exist/)
  })
})

describe('chat actions', () => {
  it('marks read, telling the network the newest bridged message that isn’t deleted', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p', { unreadCount: 3, mentionCount: 1, markedUnread: true })
    await aMessage(t, chatId, 'net_1', 1)
    await aMessage(t, chatId, 'net_2', 2, { redactedAt: 3, sealed: undefined })
    await aMessage(t, chatId, `pending:${id(9)}`, 4)
    await a.mutation(api.chats.markRead, { chatId })
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      markedUnread: false,
    })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => c.payload)).toEqual([{ type: 'markRead', portalId: 'p', upToEventId: 'net_1' }])
  })

  it('marks read locally only when nothing has reached the network', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p', { unreadCount: 1 })
    await aMessage(t, chatId, `pending:${id(1)}`, 1)
    await a.mutation(api.chats.markRead, { chatId })
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
    await a.mutation(api.chats.markUnread, { chatId })
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ markedUnread: true })
  })

  it('mutes until a time or until unmuted, and unmutes', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    await a.mutation(api.chats.setMuted, { chatId, muted: true })
    expect((await a.query(api.chats.get, { chatId })).mutedUntil).toBe(Number.MAX_SAFE_INTEGER)
    const until = Date.now() + 3_600_000
    await a.mutation(api.chats.setMuted, { chatId, muted: true, until })
    expect((await a.query(api.chats.get, { chatId })).mutedUntil).toBe(until)
    await a.mutation(api.chats.setMuted, { chatId, muted: false })
    expect((await a.query(api.chats.get, { chatId })).mutedUntil).toBeNull()
    await expect(a.mutation(api.chats.snooze, { chatId, until: Date.now() - 1 })).rejects.toThrow(/future/)
    // Within a year, as for scheduled sends.
    const day = 24 * 60 * 60 * 1000
    await a.mutation(api.chats.snooze, { chatId, until: Date.now() + 364 * day })
    await expect(a.mutation(api.chats.snooze, { chatId, until: Date.now() + 366 * day })).rejects.toThrow(/year/)
    await expect(
      a.mutation(api.chats.setMuted, { chatId, muted: true, until: Date.now() + 366 * day }),
    ).rejects.toThrow(/year/)
  })
})

describe('messages alongside the page', () => {
  it('returns only active reactions, and only live typing', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    await aMessage(t, chatId, 'net_1', 1)
    const messageId = await t.run(async (ctx) => (await ctx.db.query('messages').first())!._id)
    await t.run(async (ctx) => {
      await ctx.db.insert('reactions', {
        userId: 'user_a',
        chatId,
        messageId,
        senderKey: 'self',
        key: '👍',
        eventId: 'r1',
        addedAt: 1,
        networkTs: 1,
      })
      await ctx.db.insert('reactions', {
        userId: 'user_a',
        chatId,
        messageId,
        senderKey: 'ghost:g',
        key: '❤️',
        eventId: 'r2',
        addedAt: 1,
        networkTs: 1,
        removedAt: 2,
      })
      await ctx.db.insert('typing', { userId: 'user_a', chatId, senderKey: 'ghost:g', expiresAt: Date.now() - 1 })
      await ctx.db.insert('typing', { userId: 'user_a', chatId, senderKey: 'ghost:h', expiresAt: Date.now() + 10_000 })
    })
    expect(await a.query(api.messages.reactions, { chatId, messageIds: [messageId] })).toEqual({
      [messageId]: [{ key: '👍', senderKey: 'self' }],
    })
    expect((await a.query(api.messages.typing, { chatId })).map((row) => row.senderKey)).toEqual(['ghost:h'])
  })
})

describe('reacting', () => {
  const messageIdOf = async (t: T, eventId: string) =>
    await t.run(
      async (ctx) =>
        (await ctx.db
          .query('messages')
          .filter((q) => q.eq(q.field('eventId'), eventId))
          .first())!._id,
    )

  it('asks the bridge host to add or take away a reaction, with a deadline', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    await aMessage(t, chatId, 'net_1', 1)
    const messageId = await messageIdOf(t, 'net_1')
    const before = Date.now()
    await a.mutation(api.messages.react, { chatId, messageId, key: '❤️' })
    await a.mutation(api.messages.react, { chatId, messageId, key: '❤', remove: true })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => [c.payload, c.chatId])).toEqual([
      [{ type: 'react', portalId: 'p', targetEventId: 'net_1', key: '❤️' }, chatId],
      [{ type: 'unreact', portalId: 'p', targetEventId: 'net_1', key: '❤' }, chatId],
    ])
    for (const c of commands) expect(c.expiresAt).toBeGreaterThanOrEqual(before + 10 * 60 * 1000)
    // Nothing shows until the bridge host's echo.
    expect(await a.query(api.messages.reactions, { chatId, messageIds: [messageId] })).toEqual({ [messageId]: [] })
  })

  it('refuses a message that never reached the network, is deleted, or is in another chat', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const other = await aChat(t, 'user_a', 'q')
    await aMessage(t, chatId, `pending:${id(1)}`, 1)
    await aMessage(t, chatId, 'net_gone', 2, { redactedAt: 3, sealed: undefined })
    await aMessage(t, other, 'net_other', 4)
    for (const eventId of [`pending:${id(1)}`, 'net_gone', 'net_other']) {
      const messageId = await messageIdOf(t, eventId)
      await expect(a.mutation(api.messages.react, { chatId, messageId, key: '👍' })).rejects.toThrow(
        /can’t be reacted to/,
      )
    }
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
  })

  it('refuses a key that isn’t one reaction, a network without reactions, and someone else’s chat', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    await aMessage(t, chatId, 'net_1', 1)
    const messageId = await messageIdOf(t, 'net_1')
    for (const key of ['', 'two words', 'x'.repeat(65), 'a\u0007']) {
      await expect(a.mutation(api.messages.react, { chatId, messageId, key })).rejects.toThrow(/can’t be sent/)
    }
    await expect(b.mutation(api.messages.react, { chatId, messageId, key: '👍' })).rejects.toThrow(/doesn’t exist/)
    const voice = await aChat(t, 'user_a', 'v', { network: 'gvoice' })
    await aMessage(t, voice, 'net_v', 1, { network: 'gvoice' })
    const voiceMessage = await messageIdOf(t, 'net_v')
    await expect(a.mutation(api.messages.react, { chatId: voice, messageId: voiceMessage, key: '👍' })).rejects.toThrow(
      /Google Voice doesn’t have reactions/,
    )
    // A long joined emoji is one reaction.
    await a.mutation(api.messages.react, { chatId, messageId, key: '👨‍👩‍👧‍👦' })
  })
})

describe('the person’s own reaction on a busy message', () => {
  it('comes back past the first 100, so it can be taken away', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    await aMessage(t, chatId, 'net_1', 1)
    const messageId = await t.run(async (ctx) => (await ctx.db.query('messages').first())!._id)
    const row = (senderKey: string, key: string, eventId: string) => ({
      userId: 'user_a',
      chatId,
      messageId,
      senderKey,
      key,
      eventId,
      addedAt: 1,
      networkTs: 1,
    })
    await t.run(async (ctx) => {
      for (let r = 0; r < 100; r++) await ctx.db.insert('reactions', row(`ghost:g${r}`, '👍', `r${r}`))
      // Taken away earlier: these mustn't use up the room for the one that's still there.
      for (let r = 0; r < 25; r++)
        await ctx.db.insert('reactions', { ...row('self', `x${r}`, `gone${r}`), removedAt: 2 })
      await ctx.db.insert('reactions', row('self', '🎉', 'mine'))
    })
    const list = (await a.query(api.messages.reactions, { chatId, messageIds: [messageId] }))[messageId]!
    expect(list).toHaveLength(101)
    expect(list.filter((r) => r.senderKey === 'self')).toEqual([{ key: '🎉', senderKey: 'self' }])
  })
})

describe('contacts', () => {
  it('returns the person’s own contacts on that network, leaving out ones it doesn’t have', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await t.run(async (ctx) => {
      await ctx.db.insert('contacts', {
        userId: 'user_a',
        network: 'whatsapp',
        ghostId: 'g1',
        sealedProfile: sealed('a1'),
      })
      await ctx.db.insert('contacts', {
        userId: 'user_a',
        network: 'signal',
        ghostId: 'g2',
        sealedProfile: sealed('a2'),
      })
      await ctx.db.insert('contacts', {
        userId: 'user_b',
        network: 'whatsapp',
        ghostId: 'g2',
        sealedProfile: sealed('b2'),
      })
    })
    expect(await a.query(api.contacts.get, { network: 'whatsapp', ghostIds: ['g1', 'g2', 'g1'] })).toEqual([
      { ghostId: 'g1', sealedProfile: sealed('a1') },
    ])
    await expect(
      a.query(api.contacts.get, { network: 'whatsapp', ghostIds: Array.from({ length: 101 }, (_, i) => `g${i}`) }),
    ).rejects.toThrow(/at most 100/)
  })
})

describe('reads that large messages could push past the read limit', () => {
  const big = (tag: string) => ({ ...sealed(tag), ct: 'A'.repeat(349_524) })

  /** Messages at the size cap, each with an edit at the cap too: about 700 KiB a row. */
  async function bigMessages(t: T, chatId: Id<'chats'>, count: number, fields: Record<string, unknown> = {}) {
    const ids: Id<'messages'>[] = []
    // One transaction per row: a few of them together would pass the limit being tested.
    for (let i = 0; i < count; i++) {
      const ts = i + 1
      ids.push(
        await t.run(
          async (ctx) =>
            await ctx.db.insert('messages', {
              userId: 'user_a',
              chatId,
              network: 'whatsapp',
              eventId: `m${i}`,
              networkTs: ts,
              sortKey: `${String(ts).padStart(16, '0')}:m${i}`,
              sender: { ghostId: 'g' },
              sealed: big(`m${i}`),
              sealedObjectId: `m${i}`,
              sealedEdit: big(`e${i}`),
              editEventId: `e${i}`,
              historical: false,
              ...fields,
            }),
        ),
      )
    }
    return ids
  }

  it('marks read over many large messages, telling the network the newest it can see', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p', { unreadCount: 30 })
    await bigMessages(t, chatId, 30)
    await a.mutation(api.chats.markRead, { chatId })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((row) => row.payload)).toEqual([{ type: 'markRead', portalId: 'p', upToEventId: 'm29' }])
    expect((await a.query(api.chats.get, { chatId })).unreadCount).toBe(0)
  })

  it('marks read locally when the newest it can afford to read never reached the network', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p', { unreadCount: 1 })
    await aMessage(t, chatId, 'bridged', 0)
    // Pending copies are never this large; the point is only that the scan stops at its budget.
    for (let i = 0; i < 30; i++) {
      await aMessage(t, chatId, `pending:m${i}`, i + 1, { sealed: big(`m${i}`), sealedEdit: big(`e${i}`) })
    }
    await a.mutation(api.chats.markRead, { chatId })
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
  })

  it('returns reactions for a page of large messages without reading the messages', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    const ids = await bigMessages(t, chatId, 30)
    await t.run(async (ctx) => {
      for (const messageId of ids) {
        await ctx.db.insert('reactions', {
          userId: 'user_a',
          chatId,
          messageId,
          senderKey: 'self',
          key: '👍',
          eventId: `r${messageId}`,
          addedAt: 1,
          networkTs: 1,
        })
      }
      // A deleted message's reactions are hidden while its clean-up runs.
      await ctx.db.insert('reactionCleanups', { messageId: ids[0]!, chatId })
    })
    const result = await a.query(api.messages.reactions, { chatId, messageIds: ids })
    expect(Object.keys(result)).toHaveLength(29)
    expect(result[ids[0]!]).toBeUndefined()
    expect(result[ids[1]!]).toEqual([{ key: '👍', senderKey: 'self' }])
    // Someone else asking about these IDs, from their own chat, sees nothing of them.
    const b = await signIn(t, 'user_c')
    const theirs = await aChat(t, 'user_c', 'q')
    const seen = await b.query(api.messages.reactions, { chatId: theirs, messageIds: ids.slice(1, 3) })
    expect(Object.values(seen).flat()).toEqual([])
    // Nor does the same person asking from another of their chats.
    const other = await aChat(t, 'user_a', 'other')
    const elsewhere = await a.query(api.messages.reactions, { chatId: other, messageIds: ids.slice(0, 3) })
    // Including the deleted one: from another chat it isn't a message there, not a deleted one.
    expect(elsewhere).toEqual({ [ids[0]!]: [], [ids[1]!]: [], [ids[2]!]: [] })
  })
})

describe('reads that many large rows could push past the read limit', () => {
  it('reads reactions up to a byte budget, leaving out the messages it didn’t get to', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const ids: Id<'messages'>[] = []
    // About 140 KB of reactions each, so 70 come to about 9.5 MiB: past the 8 MiB the query
    // reads, and no more, since the rows are slow to write.
    for (let m = 0; m < 70; m++) {
      await aMessage(t, chatId, `m${m}`, m + 1)
    }
    await t.run(async (ctx) => {
      for (const message of await ctx.db.query('messages').collect()) ids.push(message._id)
    })
    // A hundred reactions on each, every one as large as ingest lets it be.
    for (const messageId of ids) {
      await t.run(async (ctx) => {
        for (let r = 0; r < 100; r++) {
          await ctx.db.insert('reactions', {
            userId: 'user_a',
            chatId,
            messageId,
            senderKey: `ghost:${String(r).padStart(256, 'g')}`,
            key: `${r}`.padStart(256, '€'),
            eventId: `${r}`.padStart(256, 'e'),
            addedAt: 1,
            networkTs: 1,
          })
        }
      })
    }
    const result = await a.query(api.messages.reactions, { chatId, messageIds: ids })
    const answered = Object.keys(result)
    expect(answered.length).toBeGreaterThan(0)
    expect(answered.length).toBeLessThan(ids.length)
    // It answers in order, each in full, and the rest can be asked for again.
    expect(answered).toEqual(ids.slice(0, answered.length))
    expect(result[ids[0]!]).toHaveLength(100)
    const rest = await a.query(api.messages.reactions, { chatId, messageIds: ids.slice(answered.length, 100) })
    expect(Object.keys(rest).length).toBeGreaterThan(0)
  })

  it('bounds a label page by items and bytes, even when a cursor range asks for more', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const work = await a.mutation(api.labels.create, { labelKey: 'label-key-work-0001', sealed: sealed('work') })
    const meta = { ...sealed('meta'), ct: 'A'.repeat(Math.floor((8 * 1024 * 4) / 3)) }
    for (let n = 0; n < 120; n++) {
      const chatId = await aChat(t, 'user_a', `c${n}`, { lastMessageAt: n, sealedMeta: meta })
      await t.run(async (ctx) => await ctx.db.insert('chatLabels', { userId: 'user_a', chatId, labelId: work }))
    }
    const all: string[] = []
    let cursor: string | null = null
    let end = ''
    for (;;) {
      const next: { page: { portalId: string }[]; isDone: boolean; continueCursor: string } = await a.query(
        api.chats.list,
        { labelId: work, paginationOpts: { numItems: 50, cursor } },
      )
      expect(next.page.length).toBeLessThanOrEqual(50)
      all.push(...next.page.map((row) => row.portalId))
      end = next.continueCursor
      if (next.isDone) break
      cursor = next.continueCursor
    }
    expect(new Set(all).size).toBe(120)
    // A reactive client reloading one page with an end cursor at the very end still gets a
    // bounded page, and is told to split it.
    const wide = await a.query(api.chats.list, {
      labelId: work,
      paginationOpts: { numItems: 50, cursor: null, endCursor: end },
    })
    expect(wide.page.length).toBeLessThanOrEqual(51)
    expect(wide.pageStatus).toBe('SplitRequired')
  })
})

describe('labels', () => {
  it('creates sealed labels, assigns them, filters by them, and removes them everywhere', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const work = await a.mutation(api.labels.create, { labelKey: 'label-key-work-0001', sealed: sealed('work') })
    expect(await a.mutation(api.labels.create, { labelKey: 'label-key-work-0001', sealed: sealed('work') })).toBe(work)
    const tagged = await aChat(t, 'user_a', 'tagged')
    await aChat(t, 'user_a', 'plain')
    await a.mutation(api.chats.setLabels, { chatId: tagged, labelIds: [work] })
    expect(
      (await a.query(api.chats.list, { labelId: work, paginationOpts: first })).page.map((r) => r.portalId),
    ).toEqual(['tagged'])
    expect((await a.query(api.chats.get, { chatId: tagged })).labelIds).toEqual([work])
    expect(await b.query(api.labels.list, {})).toHaveLength(0)
    await expect(b.query(api.chats.list, { labelId: work, paginationOpts: first })).rejects.toThrow(/doesn’t exist/)
    await expect(b.mutation(api.labels.update, { labelId: work, sealed: sealed('x') })).rejects.toThrow(/doesn’t exist/)
    await expect(b.mutation(api.labels.remove, { labelId: work })).rejects.toThrow(/doesn’t exist/)
    await a.mutation(api.labels.remove, { labelId: work })
    expect((await a.query(api.chats.get, { chatId: tagged })).labelIds).toEqual([])
    await expect(a.mutation(api.labels.create, { labelKey: 'short', sealed: sealed() })).rejects.toThrow(/label ID/)
  })
})

describe('removing a label from many chats', () => {
  it('takes it off every chat, in batches after the first thousand', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const work = await a.mutation(api.labels.create, { labelKey: 'label-key-work-0001', sealed: sealed('work') })
    const chatId = await aChat(t, 'user_a', 'p')
    await t.run(async (ctx) => {
      for (let i = 0; i < 2500; i++) await ctx.db.insert('chatLabels', { userId: 'user_a', chatId, labelId: work })
    })
    await a.mutation(api.labels.remove, { labelId: work })
    expect(await a.query(api.labels.list, {})).toHaveLength(0)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run(async (ctx) => await ctx.db.query('chatLabels').collect())).toHaveLength(0)
  })
})

describe('scheduled sends', () => {
  async function scheduleOne(a: Awaited<ReturnType<typeof signIn>>, chatId: Id<'chats'>, n: number, inMs: number) {
    return await a.mutation(api.scheduled.create, {
      chatId,
      clientMessageId: id(n),
      forBridge: sealed(`b${n}`),
      copy: sealed(`c${n}`),
      sendAt: Date.now() + inMs,
    })
  }

  it('becomes an ordinary send at its time, with its deadline starting then', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const scheduledId = (await scheduleOne(a, chatId, 1, 30 * 60 * 1000)) as Id<'scheduledSends'>
    expect(await a.query(api.scheduled.list, { chatId })).toMatchObject([{ clientMessageId: id(1) }])
    expect(await a.query(api.scheduled.copies, { scheduledIds: [scheduledId] })).toEqual([
      { _id: scheduledId, copy: sealed('c1') },
    ])
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    await t.finishInProgressScheduledFunctions()
    const [command] = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(command).toMatchObject({ clientMessageId: id(1), network: 'whatsapp', state: 'queued' })
    expect(command!.expiresAt! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(await a.query(api.scheduled.list, {})).toHaveLength(0)
    expect(await t.run(async (ctx) => await ctx.db.query('scheduledPayloads').collect())).toHaveLength(0)
  })

  it('can be cancelled or sent now, once', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    const firstId = (await scheduleOne(a, chatId, 1, 60_000)) as Id<'scheduledSends'>
    const second = (await scheduleOne(a, chatId, 2, 60_000)) as Id<'scheduledSends'>
    await expect(b.mutation(api.scheduled.cancel, { scheduledId: firstId })).rejects.toThrow(/doesn’t exist/)
    expect(await b.query(api.scheduled.copies, { scheduledIds: [firstId] })).toEqual([])
    await a.mutation(api.scheduled.cancel, { scheduledId: firstId })
    await a.mutation(api.scheduled.sendNow, { scheduledId: second })
    await expect(a.mutation(api.scheduled.sendNow, { scheduledId: second })).rejects.toThrow(/already/)
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => c.clientMessageId)).toEqual([id(2)])
    expect(await scheduleOne(a, chatId, 2, 60_000)).toBe('sent')
  })

  it('says what an ID already went as, so a second tab can tell its send from the first', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const send = (n: number) =>
      a.mutation(api.messages.send, {
        chatId,
        clientMessageId: id(n),
        forBridge: sealed(`b${n}`),
        copy: sealed(`c${n}`),
      })
    expect(await send(3)).toBe('queued')
    expect(await send(3)).toBe('sent')
    expect(await scheduleOne(a, chatId, 3, 60_000)).toBe('sent')
    expect(typeof (await scheduleOne(a, chatId, 4, 60_000))).toBe('string')
    expect(await scheduleOne(a, chatId, 4, 60_000)).toBe('scheduled')
    expect(await send(4)).toBe('scheduled')
  })

  it('fails, and says so, when its chat is gone by the time it’s due', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    const scheduledId = (await scheduleOne(a, chatId, 1, 60_000)) as Id<'scheduledSends'>
    await t.run(async (ctx) => await ctx.db.patch(chatId, { deleted: true, view: 'deleted' }))
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
    expect(await t.run(async (ctx) => await ctx.db.query('scheduledPayloads').collect())).toHaveLength(0)
    expect(await a.query(api.scheduled.list, {})).toMatchObject([{ _id: scheduledId, state: 'failed' }])
    await expect(a.mutation(api.scheduled.sendNow, { scheduledId })).rejects.toThrow(/chat is gone/)
    // Dismissing it takes it off the list.
    await a.mutation(api.scheduled.cancel, { scheduledId })
    expect(await a.query(api.scheduled.list, {})).toHaveLength(0)
  })

  it('refuses a time in the past and someone else’s chat', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    await expect(scheduleOne(a, chatId, 1, -1)).rejects.toThrow(/future/)
    await expect(scheduleOne(b, chatId, 2, 60_000)).rejects.toThrow(/doesn’t exist/)
    expect(await b.query(api.scheduled.list, {})).toHaveLength(0)
  })
})

describe('networks', () => {
  it('lists the installed networks with their login flows', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    expect(await a.query(api.networks.list, {})).toEqual([])
    await installNetworks(t)
    const networks = await a.query(api.networks.list, {})
    expect(networks.map((n) => n.network)).toEqual(['whatsapp', 'signal'])
    expect(networks[0]!.flows.map((f) => f.id)).toEqual(['qr', 'phone'])
  })

  it('offers an installed network only while the server runs its bridge host', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await installNetworks(t)
    process.env.TRIODITIS_NETWORKS = 'whatsapp'
    try {
      expect((await a.query(api.networks.list, {})).map((n) => n.network)).toEqual(['whatsapp'])
      await expect(a.mutation(api.logins.start, { network: 'signal' })).rejects.toThrow(/installed/)
    } finally {
      process.env.TRIODITIS_NETWORKS = 'whatsapp,signal'
    }
  })

  it('reports each network’s health for the person', async () => {
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    expect(await a.query(api.networks.health, {})).toMatchObject([
      { network: 'whatsapp', status: 'none', bridgeOnline: false },
      { network: 'signal', status: 'none' },
    ])
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      events: [
        { seq: 1, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state: 'CONNECTED' },
      ],
    })
    const [whatsapp] = await a.query(api.networks.health, {})
    expect(whatsapp).toMatchObject({ status: 'online', bridgeOnline: true, accounts: [{ state: 'CONNECTED' }] })
    const b = await signIn(t, 'user_b')
    expect((await b.query(api.networks.health, {}))[0]).toMatchObject({ status: 'none', accounts: [] })
  })
})

describe('accounts, logins and logout', () => {
  async function connected(t: T) {
    await heartbeat(t)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      events: [
        { seq: 1, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state: 'CONNECTED' },
      ],
    })
  }

  it('needs both key backups before a network can be connected', async () => {
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    await t.run(async (ctx) => {
      const recovery = (await ctx.db.query('keyBackups').collect()).find((row) => row.kind === 'recovery')!
      await ctx.db.delete(recovery._id)
    })
    await expect(a.mutation(api.logins.start, { network: 'whatsapp' })).rejects.toThrow(/password and recovery key/)
  })

  it('marks a logout pending, and records why one didn’t happen', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    await connected(t)
    const [account] = await a.query(api.logins.accounts, {})
    expect(account).toMatchObject({
      network: 'whatsapp',
      state: 'CONNECTED',
      error: null,
      logoutPending: false,
      logoutError: null,
    })
    expect(account).not.toHaveProperty('loginId')
    expect(await b.query(api.logins.accounts, {})).toHaveLength(0)
    await expect(b.mutation(api.logins.logout, { networkAccountId: account!._id })).rejects.toThrow(/doesn’t exist/)
    await a.mutation(api.logins.logout, { networkAccountId: account!._id })
    expect((await a.query(api.logins.accounts, {}))[0]).toMatchObject({ logoutPending: true })
    const [command] = await t.mutation(api.gateway.claimCommands, {
      secret: GATEWAY_SECRET,
      limit: 5,
      hostIds: ['whatsapp-1'],
    })
    expect(command!.payload.type).toBe('logout')
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      lease: command!.lease,
      accepted: false,
      error: 'not_connected',
    })
    expect((await a.query(api.logins.accounts, {}))[0]).toMatchObject({
      logoutPending: false,
      logoutError: 'not_connected',
    })
  })

  it('stops a logout being pending when the bridge host took it and never said how it ended', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    await connected(t)
    const [account] = await a.query(api.logins.accounts, {})
    await a.mutation(api.logins.logout, { networkAccountId: account!._id })
    const [command] = await t.mutation(api.gateway.claimCommands, {
      secret: GATEWAY_SECRET,
      limit: 5,
      hostIds: ['whatsapp-1'],
    })
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      lease: command!.lease,
      accepted: true,
    })
    expect((await a.query(api.logins.accounts, {}))[0]).toMatchObject({ logoutPending: true })
    // Past its 10-minute deadline and the hour's grace, with no `LOGGED_OUT` from the host.
    vi.advanceTimersByTime(71 * 60 * 1000)
    await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 5, hostIds: [] })
    expect((await t.run(async (ctx) => await ctx.db.query('networkAccounts').first()))!).toMatchObject({
      logoutPending: false,
      logoutError: 'timeout',
    })
  })

  it('lets only a logout’s own command end it, not an earlier one’s timeout', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    await connected(t)
    const [account] = await a.query(api.logins.accounts, {})
    // Logout A is taken and confirmed.
    await a.mutation(api.logins.logout, { networkAccountId: account!._id })
    const [first] = await t.mutation(api.gateway.claimCommands, {
      secret: GATEWAY_SECRET,
      limit: 5,
      hostIds: ['whatsapp-1'],
    })
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: first!.commandId,
      lease: first!.lease,
      accepted: true,
    })
    const report = async (seq: number, state: 'LOGGED_OUT' | 'CONNECTED') =>
      await t.mutation(api.gateway.ingest, {
        secret: GATEWAY_SECRET,
        hostId: 'whatsapp-1',
        network: 'whatsapp',
        events: [{ seq, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state }],
      })
    await report(2, 'LOGGED_OUT')
    await report(3, 'CONNECTED')
    // Logout B, a minute before A's old deadline job would time it out.
    vi.advanceTimersByTime(70 * 60 * 1000 - 60_000)
    await t.finishInProgressScheduledFunctions()
    // Signed in again: the first session has run out by now.
    const session = await t.run(
      async (ctx) =>
        (await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: 'session',
            data: {
              token: 'token-again',
              userId: 'user_a',
              expiresAt: Date.now() + 60 * 60 * 1000,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        })) as { _id: string },
    )
    const again = t.withIdentity({ subject: 'user_a', sessionId: session._id })
    await again.mutation(api.logins.logout, { networkAccountId: account!._id })
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    expect((await t.run(async (ctx) => await ctx.db.query('networkAccounts').first()))!).toMatchObject({
      logoutPending: true,
    })
    expect((await t.run(async (ctx) => await ctx.db.query('networkAccounts').first()))!.logoutError).toBeUndefined()
  })

  it('records an expired logout', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    await connected(t)
    const [account] = await a.query(api.logins.accounts, {})
    await a.mutation(api.logins.logout, { networkAccountId: account!._id })
    vi.advanceTimersByTime(11 * 60 * 1000)
    await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 5, hostIds: [] })
    expect((await t.run(async (ctx) => await ctx.db.query('networkAccounts').first()))!).toMatchObject({
      logoutPending: false,
      logoutError: 'expired',
    })
  })
})

describe('arrivals, for notifications', () => {
  it('lists messages from others by when they arrived, without history, own, deleted or other views', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const inbox = await aChat(t, 'user_a', 'inbox')
    const archived = await aChat(t, 'user_a', 'archived', { archived: true })
    await aMessage(t, inbox, 'e-first', 2_000)
    await aMessage(t, inbox, 'e-history', 5_000, { historical: true })
    await aMessage(t, inbox, 'e-mine', 5_000, { sender: { self: true } })
    await aMessage(t, inbox, 'e-deleted', 5_000, { redactedAt: 6_000 })
    await aMessage(t, archived, 'e-archived', 5_000)
    // Arrives last with an older network time: still the newest arrival.
    await aMessage(t, inbox, 'e-late', 1_000)
    const { latest, arrivals } = await a.query(api.messages.arrivals, {})
    expect(arrivals.map((x) => x.message.objectId)).toEqual(['e-late', 'e-first'])
    expect(arrivals[0]).toMatchObject({ message: { self: false, redacted: false }, chat: { portalId: 'inbox' } })
    expect(arrivals[0]!.message.sealed).not.toBeNull()
    expect(latest).toBe(arrivals[0]!.arrivedAt)
    // Someone else's messages are never theirs to see.
    const b = await signIn(t, 'user_b')
    expect(await b.query(api.messages.arrivals, {})).toEqual({ latest: null, arrivals: [] })
  })

  it('finds an arrival behind the person’s own sends, and moves the cursor past them', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const inbox = await aChat(t, 'user_a', 'inbox')
    await aMessage(t, inbox, 'e-theirs', 1_000)
    for (let n = 0; n < 12; n++) await aMessage(t, inbox, `e-mine-${n}`, 2_000 + n, { sender: { self: true } })
    const { latest, arrivals } = await a.query(api.messages.arrivals, {})
    expect(arrivals.map((x) => x.message.objectId)).toEqual(['e-theirs'])
    expect(latest).toBeGreaterThan(arrivals[0]!.arrivedAt)
  })
})
