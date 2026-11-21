import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { GATEWAY_SECRET, heartbeat, installNetworks, sealed, setup, signIn, type T } from './setup'

// After a restore, nothing the backup held as still on its way is sent again
// (gateway.settleAfterRestore, run by deploy/trioditis restore before the gateway starts).

afterEach(() => {
  vi.useRealTimers()
})

const id = (n: number) => `client-message-${String(n).padStart(4, '0')}`

async function ready() {
  const t = setup()
  await installNetworks(t)
  const as = await signIn(t, 'user_a')
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: 'whatsapp-1',
    network: 'whatsapp',
    events: [{ seq: 1, type: 'loginState', userId: 'user_a', loginId: 'login_a', at: Date.now(), state: 'CONNECTED' }],
  })
  const chatId = await t.run(
    async (ctx) =>
      await ctx.db.insert('chats', {
        userId: 'user_a',
        network: 'whatsapp',
        loginId: 'login_a',
        portalId: 'portal_1',
        kind: 'dm',
        lastMessageAt: 0,
        unreadCount: 0,
        pinned: false,
        archived: false,
        view: 'inbox',
      }),
  )
  return { t, as, chatId }
}

async function send(as: Awaited<ReturnType<typeof signIn>>, chatId: Id<'chats'>, n: number) {
  await as.mutation(api.messages.send, {
    chatId,
    clientMessageId: id(n),
    forBridge: sealed(`b${n}`),
    copy: sealed(`c${n}`),
  })
}

async function claim(t: T, limit = 1) {
  return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit, hostIds: ['whatsapp-1'] })
}

async function delivery(t: T, n: number) {
  return await t.run(async (ctx) => {
    const message = await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', 'user_a').eq('clientMessageId', id(n)))
      .first()
    const command = await ctx.db
      .query('outbox')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', 'user_a').eq('clientMessageId', id(n)))
      .first()
    return { copy: message?.delivery, command: command?.delivery, state: command?.state }
  })
}

type Phase = 'scheduled' | 'queued' | 'claimed' | 'dispatched' | 'expired'

/** What the restore does: every phase, a batch at a time, until it's done. */
async function settle(t: T, backupAt: number) {
  let phase: Phase | null = 'scheduled'
  let cursor: string | null = null
  let calls = 0
  while (phase !== null) {
    const result: { phase: Phase | null; cursor: string | null } = await t.mutation(
      internal.gateway.settleAfterRestore,
      {
        backupAt,
        phase,
        cursor,
      },
    )
    phase = result.phase
    cursor = result.cursor
    calls++
  }
  return calls
}

describe('settling after a restore', () => {
  it('makes every send still on its way unknown, and hands none of them out again', async () => {
    const { t, as, chatId } = await ready()
    const other = await t.run(
      async (ctx) =>
        await ctx.db.insert('chats', {
          userId: 'user_a',
          network: 'whatsapp',
          loginId: 'login_a',
          portalId: 'portal_2',
          kind: 'dm',
          lastMessageAt: 0,
          unreadCount: 0,
          pinned: false,
          archived: false,
          view: 'inbox',
        }),
    )
    // 1 is accepted by the bridge host, 2 claimed, 3 still queued behind 2.
    await send(as, chatId, 1)
    const [first] = await claim(t)
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: first!.commandId,
      lease: first!.lease,
      accepted: true,
    })
    await send(as, other, 2)
    await claim(t)
    await send(as, other, 3)
    await settle(t, Date.now())
    expect(await delivery(t, 1)).toMatchObject({ copy: 'unknown', command: 'unknown', state: 'dispatched' })
    expect(await delivery(t, 2)).toMatchObject({ copy: 'unknown', command: 'unknown', state: 'expired' })
    expect(await delivery(t, 3)).toMatchObject({ copy: 'unknown', command: 'unknown', state: 'expired' })
    await heartbeat(t)
    expect(await claim(t, 10)).toHaveLength(0)
    expect(await t.run(async (ctx) => await ctx.db.query('outboxPayloads').collect())).toHaveLength(0)
  })

  it('turns a send the backend failed at its start back to unknown, but not one that failed before the backup', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const { t, as, chatId } = await ready()
    await send(as, chatId, 1)
    vi.advanceTimersByTime(30 * 60 * 1000)
    await send(as, chatId, 2)
    // The first one's deadline passes with nothing claiming it, before the backup is taken.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 20 * 60 * 1000)
    await t.finishInProgressScheduledFunctions()
    expect(await delivery(t, 1)).toMatchObject({ command: 'failed' })
    const backupAt = Date.now()
    // The backup sits on disk past the second one's deadline; the backend expires it when it
    // starts.
    vi.advanceTimersByTime(60 * 60 * 1000)
    await t.finishInProgressScheduledFunctions()
    expect(await delivery(t, 2)).toMatchObject({ command: 'failed', state: 'expired' })
    await settle(t, backupAt)
    expect(await delivery(t, 1)).toMatchObject({ copy: 'failed', command: 'failed' })
    expect(await delivery(t, 2)).toMatchObject({ copy: 'unknown', command: 'unknown' })
  })

  it('makes every scheduled message unknown, even one still to come, and none fires later', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 })
    const { t, as, chatId } = await ready()
    for (const [n, ahead] of [
      [7, 60_000],
      [8, 60 * 60 * 1000],
    ] as const) {
      await as.mutation(api.scheduled.create, {
        chatId,
        clientMessageId: id(n),
        forBridge: sealed(`b${n}`),
        copy: sealed(`c${n}`),
        sendAt: Date.now() + ahead,
      })
    }
    // Restored after the first one's time, before the scheduler has run it. The second may have
    // gone early with Send now after the backup, which nothing in the backup shows.
    vi.advanceTimersByTime(61_000)
    await settle(t, Date.now() - 120_000)
    for (const n of [7, 8]) {
      expect(await delivery(t, n)).toMatchObject({ copy: 'unknown', command: 'unknown', state: 'expired' })
    }
    // Their jobs, when they run, find them already gone and send nothing.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await heartbeat(t)
    expect(await claim(t, 10)).toHaveLength(0)
    const rows = await t.run(async (ctx) => await ctx.db.query('scheduledSends').collect())
    expect(rows.map((row) => row.state)).toEqual(['sent', 'sent'])
  })

  it('works through more rows than one batch, and changes nothing when run again', async () => {
    const { t, as, chatId } = await ready()
    for (let n = 1; n <= 45; n++) await send(as, chatId, n)
    const calls = await settle(t, Date.now())
    expect(calls).toBeGreaterThan(3)
    const states = await t.run(async (ctx) => (await ctx.db.query('outbox').collect()).map((row) => row.delivery))
    expect(new Set(states)).toEqual(new Set(['unknown']))
    const before = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    await settle(t, Date.now())
    expect(await t.run(async (ctx) => await ctx.db.query('outbox').collect())).toEqual(before)
  })
})
