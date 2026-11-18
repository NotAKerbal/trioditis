import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { GATEWAY_SECRET, sealed, setup, signIn, type T } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const, commandAddr: 'http://127.0.0.1:8611' }

afterEach(() => {
  vi.useRealTimers()
})

async function aChat(t: T, userId: string, portalId = 'portal_1') {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert('chats', {
        userId,
        network: 'whatsapp',
        loginId: 'login_a',
        portalId,
        kind: 'dm',
        lastMessageAt: 0,
        unreadCount: 0,
        pinned: false,
        archived: false,
      }),
  )
}

const id = (n: number) => `client-message-${String(n).padStart(4, '0')}`

async function send(as: Awaited<ReturnType<typeof signIn>>, chatId: Id<'chats'>, n: number) {
  await as.mutation(api.messages.send, {
    chatId,
    clientMessageId: id(n),
    forBridge: sealed(`b${n}`),
    copy: sealed(`c${n}`),
  })
}

async function claim(t: T, limit = 10) {
  return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit })
}

async function status(t: T, seq: number, clientMessageId: string, value: 'submitted' | 'sent' | 'failed' | 'unknown') {
  return await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    ...HOST,
    events: [
      { seq, type: 'sendStatus', userId: 'user_a', loginId: 'login_a', at: Date.now(), clientMessageId, status: value },
    ],
  })
}

async function delivery(t: T, clientMessageId: string) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', 'user_a').eq('clientMessageId', clientMessageId))
      .first()
    return row?.delivery
  })
}

describe('sending', () => {
  it('queues a pending copy and a command, once per client message ID', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a')
    await send(as, chatId, 1)
    await send(as, chatId, 1)
    const [messages, outbox] = await t.run(async (ctx) => [
      await ctx.db.query('messages').collect(),
      await ctx.db.query('outbox').collect(),
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ eventId: `pending:${id(1)}`, sender: { self: true }, delivery: 'queued' })
    expect(outbox).toHaveLength(1)
  })

  it('refuses to send to someone else’s chat', async () => {
    const t = setup()
    await signIn(t, 'user_a')
    const other = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a')
    await expect(send(other, chatId, 1)).rejects.toThrow(/doesn’t exist/)
  })

  it('hands out one command per chat at a time, in order', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    const first = await aChat(t, 'user_a', 'p1')
    const second = await aChat(t, 'user_a', 'p2')
    await send(as, first, 1)
    await send(as, first, 2)
    await send(as, second, 3)

    const claimed = await claim(t)
    expect(claimed.map((command) => command.payload.type === 'send' && command.payload.clientMessageId)).toEqual([
      id(1),
      id(3),
    ])
    expect(await claim(t)).toHaveLength(0)

    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: claimed[0]!.commandId,
      accepted: true,
    })
    const next = await claim(t)
    expect(next.map((command) => command.payload.type === 'send' && command.payload.clientMessageId)).toEqual([id(2)])
  })

  it('hands a command out again after its lease runs out, with the same ID', async () => {
    vi.useFakeTimers()
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    const [first] = await claim(t)
    vi.advanceTimersByTime(31_000)
    const [again] = await claim(t)
    expect(again!.commandId).toEqual(first!.commandId)
    const row = await t.run(async (ctx) => await ctx.db.get(first!.commandId))
    expect(row!.attempts).toBe(2)
  })

  it('never re-queues a send whose outcome is unknown', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    const [command] = await claim(t)
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      accepted: true,
    })
    await status(t, 1, id(1), 'submitted')
    await status(t, 2, id(1), 'unknown')
    expect(await delivery(t, id(1))).toBe('unknown')
    expect(await claim(t)).toHaveLength(0)

    // A late confirmation from the network settles it.
    await status(t, 3, id(1), 'sent')
    expect(await delivery(t, id(1))).toBe('sent')
  })

  it('never moves delivery backwards', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    await status(t, 1, id(1), 'sent')
    await status(t, 2, id(1), 'submitted')
    expect(await delivery(t, id(1))).toBe('sent')
  })

  it('replaces the pending copy with the network’s echo', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      ...HOST,
      events: [
        {
          seq: 1,
          type: 'message',
          userId: 'user_a',
          loginId: 'login_a',
          at: 1,
          portalId: 'portal_1',
          eventId: 'net_1',
          networkTs: 5_000,
          sender: { self: true },
          sealed: sealed('echo'),
          historical: false,
          clientMessageId: id(1),
        },
      ],
    })
    const rows = await t.run(async (ctx) => await ctx.db.query('messages').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      eventId: 'net_1',
      sealedObjectId: 'net_1',
      delivery: 'sent',
      clientMessageId: id(1),
    })
  })

  it('expires a send that waited too long instead of sending it late', async () => {
    vi.useFakeTimers()
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    expect(await claim(t)).toHaveLength(0)
    expect(await delivery(t, id(1))).toBe('failed')
  })

  it('marks a rejected send as failed', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    const [command] = await claim(t)
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      accepted: false,
      error: 'bad portal',
    })
    expect(await delivery(t, id(1))).toBe('failed')
  })

  it('lets the person discard a send that may not have gone out', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    await send(as, await aChat(t, 'user_a'), 1)
    await expect(as.mutation(api.messages.discardSend, { clientMessageId: id(1) })).rejects.toThrow()
    await status(t, 1, id(1), 'unknown')
    await as.mutation(api.messages.discardSend, { clientMessageId: id(1) })
    expect(await t.run(async (ctx) => await ctx.db.query('messages').collect())).toHaveLength(0)
  })
})
