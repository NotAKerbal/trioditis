import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { GATEWAY_SECRET, heartbeat, sealed, setup, signIn, type T } from './setup'

afterEach(() => {
  vi.useRealTimers()
})

async function aChat(t: T, userId: string, portalId: string, fields: Record<string, unknown> = {}) {
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
        ...fields,
      }),
  )
}

async function aMessage(t: T, chatId: Id<'chats'>, eventId: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert('messages', {
      userId: 'user_a',
      chatId,
      network: 'whatsapp',
      eventId,
      networkTs: 1,
      sortKey: `0000000000000001:${eventId}`,
      sender: { ghostId: 'g' },
      sealed: sealed(eventId),
      sealedObjectId: eventId,
      historical: false,
    })
  })
}

const id = (n: number) => `client-message-${String(n).padStart(4, '0')}`

describe('chat list', () => {
  it('puts each chat in one view, pinned first, then most recent', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await aChat(t, 'user_a', 'old', { lastMessageAt: 1 })
    await aChat(t, 'user_a', 'new', { lastMessageAt: 3 })
    await aChat(t, 'user_a', 'pinned', { lastMessageAt: 2, pinned: true })
    await aChat(t, 'user_a', 'archived', { lastMessageAt: 4, archived: true })
    await aChat(t, 'user_a', 'request', { lastMessageAt: 5, isRequest: true })
    await aChat(t, 'user_a', 'blocked', { lastMessageAt: 6, blocked: true })
    await aChat(t, 'user_a', 'snoozed', { lastMessageAt: 7, snoozedUntil: Date.now() + 60_000 })
    await aChat(t, 'user_a', 'woke', { lastMessageAt: 8, snoozedUntil: Date.now() + 60_000, woke: true })
    const portals = async (view?: 'inbox' | 'archived' | 'snoozed' | 'requests' | 'blocked') =>
      (await a.query(api.chats.list, view ? { view } : {})).map((row) => row.portalId)
    expect(await portals()).toEqual(['pinned', 'woke', 'new', 'old'])
    expect(await portals('archived')).toEqual(['archived'])
    expect(await portals('requests')).toEqual(['request'])
    expect(await portals('blocked')).toEqual(['blocked'])
    expect(await portals('snoozed')).toEqual(['snoozed'])
    const [first] = await a.query(api.chats.list, {})
    expect(first).toMatchObject({
      mentionCount: 0,
      markedUnread: false,
      woke: false,
      isRequest: false,
      labelIds: [],
      networkAccountId: null,
    })
  })

  it('shows each person only their own chats', async () => {
    const t = setup()
    await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    expect(await b.query(api.chats.list, {})).toHaveLength(0)
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
      // The functions differ in their arguments; each gets the chat plus its own.
      const call = b.mutation as (fn: unknown, args: unknown) => Promise<unknown>
      await expect(call(fn, { chatId, ...extra })).rejects.toThrow(/doesn’t exist/)
    }
    await expect(b.query(api.chats.get, { chatId })).rejects.toThrow(/doesn’t exist/)
  })
})

describe('chat actions', () => {
  it('marks read, clearing counts and telling the network the latest bridged message', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p', { unreadCount: 3, mentionCount: 1, markedUnread: true })
    await aMessage(t, chatId, 'net_1')
    await a.mutation(api.chats.markRead, { chatId })
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({
      unreadCount: 0,
      mentionCount: 0,
      markedUnread: false,
    })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => c.payload)).toEqual([{ type: 'markRead', portalId: 'p', upToEventId: 'net_1' }])
    await a.mutation(api.chats.markUnread, { chatId })
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ markedUnread: true })
  })

  it('snoozes until a time, wakes then, and stays back until read', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const chatId = await aChat(t, 'user_a', 'p')
    await a.mutation(api.chats.snooze, { chatId, until: Date.now() + 60_000 })
    expect((await a.query(api.chats.list, { view: 'snoozed' })).map((r) => r._id)).toEqual([chatId])
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ woke: true })
    expect((await a.query(api.chats.list, {})).map((r) => r._id)).toEqual([chatId])
    await a.mutation(api.chats.markRead, { chatId })
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ woke: false, snoozedUntil: null })
    await expect(a.mutation(api.chats.snooze, { chatId, until: Date.now() - 1 })).rejects.toThrow(/future/)
  })

  it('mutes until a time or forever, and unmutes', async () => {
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
    expect((await a.query(api.chats.list, { labelId: work })).map((r) => r.portalId)).toEqual(['tagged'])
    expect((await a.query(api.chats.get, { chatId: tagged })).labelIds).toEqual([work])
    // Someone else can't see, use or change the label.
    expect(await b.query(api.labels.list, {})).toHaveLength(0)
    await expect(b.query(api.chats.list, { labelId: work })).rejects.toThrow(/doesn’t exist/)
    await expect(b.mutation(api.labels.update, { labelId: work, sealed: sealed('x') })).rejects.toThrow(/doesn’t exist/)
    await expect(b.mutation(api.labels.remove, { labelId: work })).rejects.toThrow(/doesn’t exist/)
    await a.mutation(api.labels.remove, { labelId: work })
    expect((await a.query(api.chats.get, { chatId: tagged })).labelIds).toEqual([])
    await expect(a.mutation(api.labels.create, { labelKey: 'short', sealed: sealed() })).rejects.toThrow(/label ID/)
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
    await scheduleOne(a, chatId, 1, 30 * 60 * 1000)
    expect(await a.query(api.scheduled.list, { chatId })).toHaveLength(1)
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toHaveLength(0)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)
    await t.finishInProgressScheduledFunctions()
    const [command] = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(command).toMatchObject({ clientMessageId: id(1), network: 'whatsapp', state: 'queued' })
    expect(command!.expiresAt! - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(await a.query(api.scheduled.list, {})).toHaveLength(0)
    const row = await t.run(async (ctx) => (await ctx.db.query('scheduledSends').collect())[0]!)
    expect(row.forBridge).toBeUndefined()
  })

  it('can be cancelled or sent now, once', async () => {
    vi.useFakeTimers()
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a', 'p')
    const first = (await scheduleOne(a, chatId, 1, 60_000))!
    const second = (await scheduleOne(a, chatId, 2, 60_000))!
    await expect(b.mutation(api.scheduled.cancel, { scheduledId: first })).rejects.toThrow(/doesn’t exist/)
    await a.mutation(api.scheduled.cancel, { scheduledId: first })
    await a.mutation(api.scheduled.sendNow, { scheduledId: second })
    await expect(a.mutation(api.scheduled.sendNow, { scheduledId: second })).rejects.toThrow(/already/)
    vi.advanceTimersByTime(61_000)
    await t.finishInProgressScheduledFunctions()
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => c.clientMessageId)).toEqual([id(2)])
    // Its ID is spent: sending or scheduling it again does nothing.
    expect(await scheduleOne(a, chatId, 2, 60_000)).toBeNull()
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
  it('lists the enabled networks with their login flows', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const networks = await a.query(api.networks.list, {})
    expect(networks.map((n) => n.network)).toEqual(['whatsapp', 'fake'])
    expect(networks[0]!.flows.map((f) => f.id)).toEqual(['qr', 'phone'])
  })

  it('reports each network’s health for the person', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    expect(await a.query(api.networks.health, {})).toMatchObject([
      { network: 'whatsapp', status: 'none', bridgeOnline: false },
      { network: 'fake', status: 'none' },
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
    // Someone else sees none of it.
    const b = await signIn(t, 'user_b')
    expect((await b.query(api.networks.health, {}))[0]).toMatchObject({ status: 'none', accounts: [] })
  })
})

describe('accounts and logout', () => {
  it('disconnects only the person’s own account', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    await heartbeat(t)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      events: [
        { seq: 1, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state: 'CONNECTED' },
      ],
    })
    const [account] = await a.query(api.logins.accounts, {})
    expect(account).toMatchObject({ network: 'whatsapp', state: 'CONNECTED', error: null })
    expect(account).not.toHaveProperty('loginId')
    expect(await b.query(api.logins.accounts, {})).toHaveLength(0)
    await expect(b.mutation(api.logins.logout, { networkAccountId: account!._id })).rejects.toThrow(/doesn’t exist/)
    await a.mutation(api.logins.logout, { networkAccountId: account!._id })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => [c.payload.type, c.loginId])).toEqual([['logout', 'login_a']])
  })
})
