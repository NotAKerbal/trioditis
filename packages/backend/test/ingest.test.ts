import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, sealed, setup, type T } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const, commandAddr: 'http://127.0.0.1:8611' }
const base = { userId: 'user_a', loginId: 'login_a', at: 1_000 }

let seq = 0
function nextSeq() {
  return ++seq
}

function message(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...base,
    seq: nextSeq(),
    type: 'message' as const,
    portalId: 'portal_1',
    eventId,
    networkTs: 2_000,
    sender: { ghostId: 'ghost_1' },
    sealed: sealed(eventId),
    historical: false,
    ...overrides,
  }
}

async function ingest(t: T, events: unknown[]) {
  return await t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, ...HOST, events: events as never })
}

async function messages(t: T) {
  return await t.run(async (ctx) => await ctx.db.query('messages').collect())
}

async function chat(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query('chats').first())!)
}

describe('ingest', () => {
  it('refuses callers without the gateway secret', async () => {
    const t = setup()
    await expect(t.mutation(api.gateway.ingest, { secret: 'wrong', ...HOST, events: [] })).rejects.toThrow(/gateway/)
  })

  it('applies events in order and acknowledges the last', async () => {
    seq = 0
    const t = setup()
    expect(await ingest(t, [message('e1'), message('e2', { networkTs: 3_000 })])).toEqual({ ackedThrough: 2 })
    const rows = await messages(t)
    expect(rows.map((row) => row.eventId)).toEqual(['e1', 'e2'])
    expect((await chat(t)).unreadCount).toBe(2)
  })

  it('skips replays, so at-least-once delivery stores each message once', async () => {
    seq = 0
    const t = setup()
    const batch = [message('e1'), message('e2')]
    await ingest(t, batch)
    expect(await ingest(t, batch)).toEqual({ ackedThrough: 2 })
    expect(await messages(t)).toHaveLength(2)
    expect((await chat(t)).unreadCount).toBe(2)
  })

  it('answers a gap with the sequence to resend from', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('e1')])
    seq = 5
    expect(await ingest(t, [message('e6')])).toEqual({ expectedSeq: 2 })
    expect(await messages(t)).toHaveLength(1)
  })

  it('rejects plaintext content', async () => {
    seq = 0
    const t = setup()
    const plaintext = { ...message('e1'), sealed: undefined, body: 'hello' }
    await expect(ingest(t, [plaintext])).rejects.toThrow()
  })

  it('orders by network time, not arrival', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('late', { networkTs: 9_000 }), message('early', { networkTs: 1_000 })])
    const ordered = await t.run(
      async (ctx) =>
        await ctx.db
          .query('messages')
          .withIndex('by_chat_sort', (q) => q)
          .collect(),
    )
    expect(ordered.map((row) => row.eventId)).toEqual(['early', 'late'])
  })

  it('imports history without unread counts or inbox reordering', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('old', { historical: true, networkTs: 500 })])
    const imported = await chat(t)
    expect(imported.unreadCount).toBe(0)
    expect(imported.lastMessageAt).toBe(0)
  })

  it('does not count the person’s own messages as unread', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('mine', { sender: { self: true } })])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('applies edits, reactions and deletes to their message', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1'),
      {
        ...base,
        seq: nextSeq(),
        type: 'edit',
        portalId: 'portal_1',
        eventId: 'edit1',
        targetEventId: 'e1',
        networkTs: 2_500,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed('edit1'),
      },
      {
        ...base,
        seq: nextSeq(),
        type: 'reaction',
        portalId: 'portal_1',
        eventId: 'r1',
        targetEventId: 'e1',
        sender: { self: true },
        key: '👍',
        networkTs: 2_600,
      },
      {
        ...base,
        seq: nextSeq(),
        type: 'reaction',
        portalId: 'portal_1',
        eventId: 'r1',
        targetEventId: 'e1',
        sender: { self: true },
        key: '👍',
        networkTs: 2_600,
      },
    ])
    let [row] = await messages(t)
    expect(row!.editEventId).toBe('edit1')
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(1)

    await ingest(t, [
      {
        ...base,
        seq: nextSeq(),
        type: 'redaction',
        portalId: 'portal_1',
        targetEventId: 'e1',
        sender: { ghostId: 'ghost_1' },
        networkTs: 3_000,
      },
    ])
    ;[row] = await messages(t)
    expect(row!.redactedAt).toBe(3_000)
    expect(row!.sealed).toBeUndefined()
    expect(row!.sealedEdit).toBeUndefined()
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(0)
  })

  it('quarantines an event it can’t apply and carries on', async () => {
    seq = 0
    const t = setup()
    const result = await ingest(t, [
      {
        ...base,
        seq: nextSeq(),
        type: 'edit',
        portalId: 'portal_1',
        eventId: 'x',
        targetEventId: 'missing',
        networkTs: 1,
        sender: { ghostId: 'g' },
        sealed: sealed(),
      },
      message('e2'),
    ])
    expect(result).toEqual({ ackedThrough: 2 })
    expect(await t.run(async (ctx) => await ctx.db.query('quarantine').collect())).toMatchObject([
      { seq: 1, type: 'edit' },
    ])
    expect(await messages(t)).toHaveLength(1)
  })

  it('clears unread when the person reads the chat elsewhere', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1'),
      {
        ...base,
        seq: nextSeq(),
        type: 'receipt',
        portalId: 'portal_1',
        sender: { self: true },
        upToEventId: 'e1',
        networkTs: 2_100,
      },
    ])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('records login state per account', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [{ ...base, seq: nextSeq(), type: 'loginState', state: 'CONNECTED' }])
    const [account] = await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())
    expect(account).toMatchObject({ userId: 'user_a', network: 'whatsapp', state: 'CONNECTED', lastHealthyAt: 1_000 })
  })
})
