import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { GATEWAY_SECRET, heartbeat, sealed, setup, signIn, type T } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }

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

const REACHABLE = ['whatsapp-1', 'whatsapp-2']

async function claim(t: T, limit = 10, hostIds = REACHABLE) {
  return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit, hostIds })
}

async function payloadOf(t: T, clientMessageId: string) {
  const row = await outboxRow(t, clientMessageId)
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query('outboxPayloads')
        .withIndex('by_command', (q) => q.eq('commandId', row!._id))
        .unique(),
  )
}

const sentIds = (claimed: Awaited<ReturnType<typeof claim>>) =>
  claimed.map((command) => (command.payload.type === 'send' ? command.payload.clientMessageId : command.payload.type))

let seq = 0
async function status(t: T, clientMessageId: string, value: 'submitted' | 'sent' | 'failed' | 'unknown') {
  return await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    ...HOST,
    events: [
      {
        seq: ++seq,
        type: 'sendStatus',
        userId: 'user_a',
        loginId: 'login_a',
        at: Date.now(),
        clientMessageId,
        status: value,
      },
    ],
  })
}

async function accept(t: T, command: { commandId: Id<'outbox'>; lease: number }) {
  await t.mutation(api.gateway.commandResult, {
    secret: GATEWAY_SECRET,
    commandId: command.commandId,
    lease: command.lease,
    accepted: true,
  })
}

async function outboxRow(t: T, clientMessageId: string) {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query('outbox')
        .withIndex('by_clientMessageId', (q) => q.eq('userId', 'user_a').eq('clientMessageId', clientMessageId))
        .first(),
  )
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

/** The person's login runs on `hostId`, as the host's `loginState` reports establish. */
async function loginOn(t: T, hostId: string) {
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId,
    network: 'whatsapp',
    events: [{ seq: 1, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state: 'CONNECTED' }],
  })
}

async function ready() {
  seq = 0
  const t = setup()
  const as = await signIn(t, 'user_a')
  await loginOn(t, 'whatsapp-1')
  seq = 1
  return { t, as }
}

describe('sending', () => {
  it('queues a pending copy and a command, once per client message ID', async () => {
    const { t, as } = await ready()
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

  it('refuses an unsealed message and someone else’s chat', async () => {
    const { t, as } = await ready()
    const other = await signIn(t, 'user_b')
    const chatId = await aChat(t, 'user_a')
    await expect(send(other, chatId, 1)).rejects.toThrow(/doesn’t exist/)
    await expect(
      as.mutation(api.messages.send, {
        chatId,
        clientMessageId: id(2),
        forBridge: { v: 1, nonce: 'x', ct: 'plaintext', keys: [] },
        copy: sealed(),
      }),
    ).rejects.toThrow(/sealed/)
  })

  it('hands the bridge-readable copy out with the command, and the deadline', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    const [command] = await claim(t)
    expect(command).toMatchObject({ hostId: 'whatsapp-1', lease: 1, sealed: sealed('b1') })
    expect(command!.notAfter).toBeGreaterThan(Date.now())
  })

  it('claims nothing while no bridge host for the network is live', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    vi.advanceTimersByTime(3 * 60_000)
    expect(await claim(t)).toHaveLength(0)
    expect((await outboxRow(t, id(1)))!.state).toBe('queued')
    await heartbeat(t)
    expect(await claim(t)).toHaveLength(1)
  })

  it('hands out one command per chat at a time, in creation order, even within a millisecond', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const { t, as } = await ready()
    const first = await aChat(t, 'user_a', 'p1')
    const second = await aChat(t, 'user_a', 'p2')
    await send(as, first, 1)
    await send(as, first, 2)
    await send(as, second, 3)
    const claimed = await claim(t)
    expect(sentIds(claimed)).toEqual([id(1), id(3)])
    expect(await claim(t)).toHaveLength(0)
    await accept(t, claimed[0]!)
    expect(sentIds(await claim(t))).toEqual([id(2)])
  })

  it('keeps a stuck chat from holding back other chats', async () => {
    const { t, as } = await ready()
    const stuck = await aChat(t, 'user_a', 'stuck')
    const healthy = await aChat(t, 'user_a', 'healthy')
    for (let n = 1; n <= 40; n++) await send(as, stuck, n)
    await send(as, healthy, 99)
    expect(sentIds(await claim(t, 1))).toEqual([id(1)])
    expect(sentIds(await claim(t))).toEqual([id(99)])
  })

  it('never delivers again once the bridge host has reported on the send, even if its 202 was lost', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    // The 202 never arrives; the bridge host's status does.
    await status(t, id(1), 'unknown')
    expect(await outboxRow(t, id(1))).toMatchObject({ state: 'dispatched', delivery: 'unknown' })
    vi.advanceTimersByTime(31_000)
    await heartbeat(t)
    expect(await claim(t)).toHaveLength(0)
    expect(await delivery(t, id(1))).toBe('unknown')
    // A late confirmation from the network settles it.
    await status(t, id(1), 'sent')
    expect(await delivery(t, id(1))).toBe('sent')
  })

  it('ignores a result for an earlier lease', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    const [first] = await claim(t)
    vi.advanceTimersByTime(31_000)
    await heartbeat(t)
    const [second] = await claim(t)
    expect(second).toMatchObject({ commandId: first!.commandId, lease: 2 })
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: first!.commandId,
      lease: first!.lease,
      accepted: false,
      error: 'invalid_command',
    })
    expect((await outboxRow(t, id(1)))!.state).toBe('claimed')
    await accept(t, second!)
    expect((await outboxRow(t, id(1)))!.state).toBe('dispatched')
  })

  it('delivers a command that may have reached a host only to that host again', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    vi.advanceTimersByTime(3 * 60_000)
    // whatsapp-1 went quiet; a replacement, whatsapp-2, is live.
    await heartbeat(t, 'whatsapp-2')
    expect(await claim(t)).toHaveLength(0)
    await heartbeat(t, 'whatsapp-1')
    expect(await claim(t)).toMatchObject([{ hostId: 'whatsapp-1' }])
  })

  it('deletes the bridge-readable copy once the bridge host has it', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    expect(await payloadOf(t, id(1))).not.toBeNull()
    const [command] = await claim(t)
    await accept(t, command!)
    expect(await payloadOf(t, id(1))).toBeNull()
  })

  it('never moves delivery backwards', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    await status(t, id(1), 'sent')
    await status(t, id(1), 'submitted')
    expect(await delivery(t, id(1))).toBe('sent')
  })

  it('replaces the pending copy with the network’s echo and settles the send', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      ...HOST,
      events: [
        {
          seq: ++seq,
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
    const row = await outboxRow(t, id(1))
    expect(row).toMatchObject({ state: 'dispatched', delivery: 'sent' })
    expect(await payloadOf(t, id(1))).toBeNull()
  })

  it('fails a send that never went out in time, without sending it late', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    await heartbeat(t)
    expect(await claim(t)).toHaveLength(0)
    expect(await delivery(t, id(1))).toBe('failed')
    const row = await outboxRow(t, id(1))
    expect(row).toMatchObject({ state: 'expired', lastError: 'expired' })
    expect(await payloadOf(t, id(1))).toBeNull()
  })

  it('marks a send unknown when its deadline passes while it may be with the bridge host', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    await heartbeat(t)
    expect(await claim(t)).toHaveLength(0)
    expect(await delivery(t, id(1))).toBe('unknown')
  })

  it('marks a rejected send as failed, keeping only the error code', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    const [command] = await claim(t)
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      lease: command!.lease,
      accepted: false,
      error: 'invalid_command',
    })
    expect(await delivery(t, id(1))).toBe('failed')
    expect(await outboxRow(t, id(1))).toMatchObject({ state: 'rejected', lastError: 'invalid_command' })
  })

  it('lets the person discard a send that may not have gone out', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    await expect(as.mutation(api.messages.discardSend, { clientMessageId: id(1) })).rejects.toThrow()
    await status(t, id(1), 'unknown')
    await as.mutation(api.messages.discardSend, { clientMessageId: id(1) })
    expect(await t.run(async (ctx) => await ctx.db.query('messages').collect())).toHaveLength(0)
  })

  it('sends a login’s commands to the host running it, and only to hosts the gateway can reach', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    // A newer host for the network heartbeats; the send still goes where the login lives.
    await heartbeat(t, 'whatsapp-2')
    expect(await claim(t, 10, ['whatsapp-2'])).toHaveLength(0)
    expect(await claim(t)).toMatchObject([{ hostId: 'whatsapp-1' }])
  })

  it('refuses a send status from a host the send didn’t go to', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-2',
      network: 'whatsapp',
      events: [
        {
          seq: 1,
          type: 'sendStatus',
          userId: 'user_a',
          loginId: 'login_a',
          at: 1,
          clientMessageId: id(1),
          status: 'failed',
        },
      ],
    })
    expect(await outboxRow(t, id(1))).toMatchObject({ state: 'claimed', delivery: 'claimed' })
    expect(await payloadOf(t, id(1))).not.toBeNull()
    const quarantined = await t.run(async (ctx) => await ctx.db.query('quarantine').collect())
    expect(quarantined).toMatchObject([{ hostId: 'whatsapp-2', reason: 'foreign_host' }])
  })

  it('drops login input that never reached a bridge host, and ends the login', async () => {
    vi.useFakeTimers()
    seq = 0
    const t = setup()
    const as = await signIn(t, 'user_a')
    const loginSessionId = await as.mutation(api.logins.start, { network: 'whatsapp' })
    await t.run(async (ctx) => {
      await ctx.db.patch(loginSessionId, {
        state: 'active',
        step: { stepId: 's1', type: 'userInput' },
        hostId: 'whatsapp-1',
      })
    })
    await as.mutation(api.logins.submit, { loginSessionId, stepId: 's1', sealed: sealed('cookies') })
    vi.advanceTimersByTime(11 * 60 * 1000)
    await heartbeat(t)
    expect(await claim(t)).toHaveLength(0)
    const [payloads, session] = await t.run(async (ctx) => [
      await ctx.db.query('outboxPayloads').collect(),
      await ctx.db.get(loginSessionId),
    ])
    expect(payloads).toHaveLength(0)
    expect(session).toMatchObject({ state: 'error', step: { error: 'expired' } })
  })

  it('only lets a reply quote a message in the same chat', async () => {
    const { t, as } = await ready()
    const here = await aChat(t, 'user_a', 'here')
    const there = await aChat(t, 'user_a', 'there')
    await t.run(async (ctx) => {
      for (const [chatId, eventId] of [
        [here, 'in_here'],
        [there, 'in_there'],
      ] as const) {
        await ctx.db.insert('messages', {
          userId: 'user_a',
          chatId,
          network: 'whatsapp',
          eventId,
          networkTs: 1,
          sortKey: `1:${eventId}`,
          sender: { ghostId: 'g' },
          sealed: sealed(eventId),
          sealedObjectId: eventId,
          historical: false,
        })
      }
    })
    const reply = (n: number, replyTo: string) =>
      as.mutation(api.messages.send, {
        chatId: here,
        clientMessageId: id(n),
        forBridge: sealed(),
        copy: sealed(),
        replyTo,
      })
    await expect(reply(1, 'in_there')).rejects.toThrow(/replied to/)
    await expect(reply(2, 'nowhere')).rejects.toThrow(/replied to/)
    await reply(3, 'in_here')
  })

  it('refuses a status or echo for a send no host has been handed yet', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await status(t, id(1), 'failed')
    expect(await outboxRow(t, id(1))).toMatchObject({ state: 'queued', delivery: 'queued' })
    expect(await payloadOf(t, id(1))).not.toBeNull()
  })

  it('refuses an echo from the wrong host, so the right host’s echo still settles the send', async () => {
    const { t, as } = await ready()
    await send(as, await aChat(t, 'user_a'), 1)
    await claim(t)
    const echo = (hostId: string, n: number) =>
      t.mutation(api.gateway.ingest, {
        secret: GATEWAY_SECRET,
        hostId,
        network: 'whatsapp',
        events: [
          {
            seq: n,
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
    await echo('whatsapp-2', 1)
    expect(await t.run(async (ctx) => await ctx.db.query('messages').collect())).toMatchObject([
      { eventId: `pending:${id(1)}` },
    ])
    await echo('whatsapp-1', ++seq)
    const rows = await t.run(async (ctx) => await ctx.db.query('messages').collect())
    expect(rows).toMatchObject([{ eventId: 'net_1', delivery: 'sent' }])
  })

  it('refuses sends and login input bigger than the limit', async () => {
    const { t, as } = await ready()
    const chatId = await aChat(t, 'user_a')
    const big = { ...sealed(), ct: 'A'.repeat(Math.ceil(((64 * 1024 + 1) * 4) / 3)) }
    await expect(
      as.mutation(api.messages.send, { chatId, clientMessageId: id(1), forBridge: big, copy: sealed() }),
    ).rejects.toThrow(/too long/)
  })

  it('expires a bounded number of commands per claim', async () => {
    vi.useFakeTimers()
    const { t, as } = await ready()
    for (let n = 1; n <= 60; n++) await send(as, await aChat(t, 'user_a', `p${n}`), n)
    vi.advanceTimersByTime(25 * 60 * 60 * 1000)
    await loginOn(t, 'whatsapp-1')
    await claim(t)
    const expired = async () =>
      (await t.run(async (ctx) => await ctx.db.query('outbox').collect())).filter((row) => row.state === 'expired')
        .length
    expect(await expired()).toBe(20)
    await claim(t)
    await claim(t)
    expect(await expired()).toBe(60)
  })

  it('keeps a login with the host that last reported it connected', async () => {
    const { t, as } = await ready()
    const report = (hostId: string, at: number, state: 'CONNECTED' | 'TRANSIENT_DISCONNECT') =>
      t.mutation(api.gateway.ingest, {
        secret: GATEWAY_SECRET,
        hostId,
        network: 'whatsapp',
        events: [
          {
            seq: hostId === 'whatsapp-1' ? ++seq : 1,
            type: 'loginState',
            userId: 'user_a',
            loginId: 'login_a',
            at,
            state,
          },
        ],
      })
    await report('whatsapp-2', Date.now() + 1_000, 'CONNECTED')
    // A delayed report from the host that ran it before doesn't take it back.
    await report('whatsapp-1', Date.now(), 'TRANSIENT_DISCONNECT')
    await send(as, await aChat(t, 'user_a'), 1)
    expect(await claim(t)).toMatchObject([{ hostId: 'whatsapp-2' }])
  })

  it('lets only the host running a login report its steps, and doesn’t let an old submission end a newer step', async () => {
    vi.useFakeTimers()
    seq = 0
    const t = setup()
    const as = await signIn(t, 'user_a')
    await heartbeat(t)
    const loginSessionId = await as.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    const step = (hostId: string, n: number, stepId: string) =>
      t.mutation(api.gateway.ingest, {
        secret: GATEWAY_SECRET,
        hostId,
        network: 'whatsapp',
        events: [
          {
            seq: n,
            type: 'loginStep',
            userId: 'user_a',
            loginId: '',
            at: Date.now(),
            loginSessionId,
            step: { stepId, type: 'userInput' },
          },
        ],
      })
    await step('whatsapp-2', 1, 'spoofed')
    expect((await as.query(api.logins.session, { loginSessionId }))!.state).toBe('pending')
    await step('whatsapp-1', 1, 's1')
    await as.mutation(api.logins.submit, { loginSessionId, stepId: 's1', sealed: sealed('a') })
    await step('whatsapp-1', 2, 's2')
    vi.advanceTimersByTime(11 * 60 * 1000)
    await heartbeat(t)
    await claim(t)
    expect(await as.query(api.logins.session, { loginSessionId })).toMatchObject({
      state: 'active',
      step: { stepId: 's2' },
    })
  })

  it('ignores a late step for a login that has ended, and steps before the login was handed out', async () => {
    vi.useFakeTimers()
    seq = 0
    const t = setup()
    const as = await signIn(t, 'user_a')
    await heartbeat(t)
    const loginSessionId = await as.mutation(api.logins.start, { network: 'whatsapp' })
    const step = (n: number, stepId: string) =>
      t.mutation(api.gateway.ingest, {
        secret: GATEWAY_SECRET,
        hostId: 'whatsapp-1',
        network: 'whatsapp',
        events: [
          {
            seq: n,
            type: 'loginStep',
            userId: 'user_a',
            loginId: '',
            at: Date.now(),
            loginSessionId,
            step: { stepId, type: 'userInput' },
          },
        ],
      })
    await step(1, 'early')
    expect((await as.query(api.logins.session, { loginSessionId }))!.state).toBe('pending')
    await claim(t)
    await step(2, 's1')
    await as.mutation(api.logins.cancel, { loginSessionId })
    vi.advanceTimersByTime(11 * 60 * 1000)
    await heartbeat(t)
    await claim(t, 10, [])
    expect((await as.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
    await step(3, 's2')
    expect((await as.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
  })

  it('refuses a login flow ID that isn’t one', async () => {
    const { as } = await ready()
    await expect(as.mutation(api.logins.start, { network: 'whatsapp', flowId: 'x'.repeat(1000) })).rejects.toThrow(
      /login method/,
    )
  })

  it('keeps a retried send idempotent even if what it replied to was deleted since', async () => {
    const { t, as } = await ready()
    const chatId = await aChat(t, 'user_a')
    await t.run(async (ctx) => {
      await ctx.db.insert('messages', {
        userId: 'user_a',
        chatId,
        network: 'whatsapp',
        eventId: 'quoted',
        networkTs: 1,
        sortKey: '1:quoted',
        sender: { ghostId: 'g' },
        sealed: sealed('q'),
        sealedObjectId: 'quoted',
        historical: false,
      })
    })
    const reply = () =>
      as.mutation(api.messages.send, {
        chatId,
        clientMessageId: id(1),
        forBridge: sealed(),
        copy: sealed(),
        replyTo: 'quoted',
      })
    await reply()
    await t.run(async (ctx) => {
      const quoted = (await ctx.db.query('messages').collect()).find((m) => m.eventId === 'quoted')!
      await ctx.db.patch(quoted._id, { redactedAt: 2 })
    })
    await reply()
    await send(as, chatId, 2)
    await expect(
      as.mutation(api.messages.send, {
        chatId,
        clientMessageId: id(3),
        forBridge: sealed(),
        copy: sealed(),
        replyTo: `pending:${id(2)}`,
      }),
    ).rejects.toThrow(/replied to/)
  })
})
