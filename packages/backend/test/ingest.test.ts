import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, sealed, setup, type T } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }
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

const event = (type: string, fields: Record<string, unknown>) => ({ ...base, seq: nextSeq(), type, ...fields })

async function ingest(t: T, events: unknown[]) {
  return await t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, ...HOST, events: events as never })
}

async function messages(t: T) {
  return await t.run(async (ctx) => await ctx.db.query('messages').collect())
}

async function chat(t: T) {
  return await t.run(async (ctx) => (await ctx.db.query('chats').first())!)
}

async function quarantined(t: T) {
  return await t.run(async (ctx) => await ctx.db.query('quarantine').collect())
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
    expect((await messages(t)).map((row) => row.eventId)).toEqual(['e1', 'e2'])
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

  it('commits the events before a gap, then asks for the rest', async () => {
    seq = 0
    const t = setup()
    const first = message('e1')
    seq = 5
    const afterGap = message('e6')
    expect(await ingest(t, [first, afterGap])).toEqual({ expectedSeq: 2 })
    expect((await messages(t)).map((row) => row.eventId)).toEqual(['e1'])
    // The resend from 2 onwards, including the replayed 1, goes through.
    seq = 1
    const resent = [first, message('e2'), message('e3'), message('e4'), message('e5'), afterGap]
    expect(await ingest(t, resent)).toEqual({ ackedThrough: 6 })
    expect(await messages(t)).toHaveLength(6)
  })

  it('treats an empty batch as a heartbeat that reports where it is', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('e1')])
    expect(await ingest(t, [])).toEqual({ ackedThrough: 1 })
  })

  it('rejects plaintext content', async () => {
    seq = 0
    const t = setup()
    const plaintext = { ...message('e1'), sealed: undefined, body: 'hello' }
    await expect(ingest(t, [plaintext])).rejects.toThrow()
  })

  it('quarantines an envelope that isn’t one', async () => {
    seq = 0
    const t = setup()
    const notSealed = { v: 1, nonce: 'n', ct: 'hello in plaintext', keys: [] }
    expect(await ingest(t, [message('e1', { sealed: notSealed }), message('e2')])).toEqual({ ackedThrough: 2 })
    expect(await quarantined(t)).toMatchObject([{ seq: 1, reason: 'malformed_envelope' }])
    expect((await messages(t)).map((row) => row.eventId)).toEqual(['e2'])
  })

  it('skips an invalid event only at the next expected sequence', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('e1')])
    const skip = (n: number) =>
      t.mutation(api.gateway.quarantineInvalid, { secret: GATEWAY_SECRET, ...HOST, seq: n, type: 'message' })
    expect(await skip(3)).toEqual({ expectedSeq: 2 })
    expect(await skip(2)).toEqual({ ackedThrough: 2 })
    expect(await skip(2)).toEqual({ ackedThrough: 2 })
    expect(await quarantined(t)).toMatchObject([{ seq: 2, reason: 'invalid_event' }])
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
    expect(await chat(t)).toMatchObject({ unreadCount: 0, lastMessageAt: 0 })
  })

  it('does not count the person’s own messages as unread', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('mine', { sender: { self: true } })])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('accepts an edit made from Trioditis, which carries its client message ID', async () => {
    seq = 0
    const t = setup()
    const original = message('e1', { sender: { self: true } })
    const edit = event('edit', {
      portalId: 'portal_1',
      eventId: 'edit1',
      targetEventId: 'e1',
      networkTs: 2_500,
      sender: { self: true },
      sealed: sealed('edit1'),
      clientMessageId: 'client-message-0001',
    })
    expect(await ingest(t, [original, edit])).toEqual({ ackedThrough: 2 })
    expect((await messages(t))[0]).toMatchObject({ editEventId: 'edit1' })
  })

  it('applies edits, reactions and deletes to their message', async () => {
    seq = 0
    const t = setup()
    const reaction = (eventId: string) =>
      event('reaction', {
        portalId: 'portal_1',
        eventId,
        targetEventId: 'e1',
        sender: { self: true },
        key: '👍',
        networkTs: 2_600,
      })
    await ingest(t, [
      message('e1'),
      event('edit', {
        portalId: 'portal_1',
        eventId: 'edit1',
        targetEventId: 'e1',
        networkTs: 2_500,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed('edit1'),
      }),
      reaction('r1'),
    ])
    let [row] = await messages(t)
    expect(row!.editEventId).toBe('edit1')
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(1)

    await ingest(t, [
      event('redaction', {
        portalId: 'portal_1',
        targetEventId: 'e1',
        sender: { ghostId: 'ghost_1' },
        networkTs: 3_000,
      }),
    ])
    ;[row] = await messages(t)
    expect(row).toMatchObject({ redactedAt: 3_000 })
    expect(row!.sealed).toBeUndefined()
    expect(row!.sealedEdit).toBeUndefined()
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(0)

    // Nothing brings a deleted message's content back.
    await ingest(t, [
      event('edit', {
        portalId: 'portal_1',
        eventId: 'edit2',
        targetEventId: 'e1',
        networkTs: 4_000,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed('edit2'),
      }),
      reaction('r2'),
    ])
    ;[row] = await messages(t)
    expect(row!.sealedEdit).toBeUndefined()
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(0)
  })

  it('doesn’t bring back a removed reaction when its event is replayed, but does for a new one', async () => {
    seq = 0
    const t = setup()
    let clock = 1_000
    const add = (eventId: string) => ({
      ...event('reaction', {
        portalId: 'portal_1',
        eventId,
        targetEventId: 'e1',
        sender: { ghostId: 'g' },
        key: '❤️',
        networkTs: 1,
      }),
      at: ++clock,
    })
    const remove = () => ({
      ...event('reactionRemove', { portalId: 'portal_1', targetEventId: 'e1', sender: { ghostId: 'g' }, key: '❤️' }),
      at: ++clock,
    })
    const active = async () =>
      (await t.run(async (ctx) => await ctx.db.query('reactions').collect())).filter((r) => r.removedAt === undefined)
    await ingest(t, [message('e1'), add('r1'), remove(), add('r1')])
    expect(await active()).toHaveLength(0)
    await ingest(t, [add('r2')])
    expect(await active()).toMatchObject([{ eventId: 'r2' }])
    await ingest(t, [remove(), add('r1')])
    expect(await active()).toHaveLength(0)
  })

  it('doesn’t let a replayed old removal undo a later add', async () => {
    seq = 0
    const t = setup()
    const add = (at: number) => ({
      ...event('reaction', {
        portalId: 'portal_1',
        eventId: `r${at}`,
        targetEventId: 'e1',
        sender: { ghostId: 'g' },
        key: '❤️',
        networkTs: at,
      }),
      at,
    })
    const remove = (at: number) => ({
      ...event('reactionRemove', { portalId: 'portal_1', targetEventId: 'e1', sender: { ghostId: 'g' }, key: '❤️' }),
      at,
    })
    await ingest(t, [message('e1'), add(10), remove(20), add(30), remove(20), remove(30)])
    const reactions = await t.run(async (ctx) => await ctx.db.query('reactions').collect())
    expect(reactions).toMatchObject([{ eventId: 'r30' }])
    expect(reactions[0]!.removedAt).toBeUndefined()
  })

  it('matches an echo only to a pending copy of the person’s own message in that chat', async () => {
    seq = 0
    const t = setup()
    // A message from someone else carrying a client message ID is just a message.
    await ingest(t, [message('e1', { clientMessageId: 'client-message-0001' })])
    await ingest(t, [message('e2', { clientMessageId: 'client-message-0001', sender: { self: true } })])
    expect((await messages(t)).map((row) => row.eventId).sort()).toEqual(['e1', 'e2'])
  })

  it('quarantines an event it can’t apply and carries on', async () => {
    seq = 0
    const t = setup()
    const result = await ingest(t, [
      event('edit', {
        portalId: 'portal_1',
        eventId: 'x',
        targetEventId: 'missing',
        networkTs: 1,
        sender: { ghostId: 'g' },
        sealed: sealed(),
      }),
      event('loginStep', { loginSessionId: 'not-a-session-id', step: { stepId: 's', type: 'complete' } }),
      message('e3'),
    ])
    expect(result).toEqual({ ackedThrough: 3 })
    expect((await quarantined(t)).map((row) => [row.type, row.reason])).toEqual([
      ['edit', 'missing_target'],
      ['loginStep', 'unknown_login_session'],
    ])
    expect(await messages(t)).toHaveLength(1)
  })

  it('clears unread when the person reads the chat elsewhere', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1'),
      event('receipt', { portalId: 'portal_1', sender: { self: true }, upToEventId: 'e1', networkTs: 2_100 }),
    ])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('records login state per account, with error codes only', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [event('loginState', { state: 'CONNECTED' })])
    const [account] = await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())
    expect(account).toMatchObject({ userId: 'user_a', network: 'whatsapp', state: 'CONNECTED', lastHealthyAt: 1_000 })
    await expect(
      ingest(t, [event('loginState', { state: 'UNKNOWN_ERROR', error: 'wrong code 123456' })]),
    ).rejects.toThrow()
  })

  it('quarantines an envelope too big to store', async () => {
    seq = 0
    const t = setup()
    const big = { ...sealed('big'), ct: 'A'.repeat(Math.ceil(((256 * 1024 + 1) * 4) / 3)) }
    expect(await ingest(t, [message('e1', { sealed: big }), message('e2')])).toEqual({ ackedThrough: 2 })
    expect(await quarantined(t)).toMatchObject([{ seq: 1, reason: 'too_large' }])
  })

  it('refuses events for a login from a host that isn’t running it', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [event('loginState', { state: 'CONNECTED' })])
    const fromOther = await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-2',
      network: 'whatsapp',
      events: [{ ...message('e1'), seq: 1 }],
    })
    expect(fromOther).toEqual({ ackedThrough: 1 })
    expect(await messages(t)).toHaveLength(0)
    expect(await quarantined(t)).toMatchObject([{ hostId: 'whatsapp-2', reason: 'foreign_host' }])
  })

  it('quarantines an event carrying an ID too long to be one', async () => {
    seq = 0
    const t = setup()
    expect(await ingest(t, [message('x'.repeat(300)), message('e2')])).toEqual({ ackedThrough: 2 })
    expect(await quarantined(t)).toMatchObject([{ seq: 1, reason: 'too_large' }])
  })

  it('stores a message and an edit both at the size limit', async () => {
    seq = 0
    const t = setup()
    const atLimit = (tag: string) => ({ ...sealed(tag), ct: 'A'.repeat(349_524) })
    const original = message('e1', { sealed: atLimit('m') })
    const edit = event('edit', {
      portalId: 'portal_1',
      eventId: 'edit1',
      targetEventId: 'e1',
      networkTs: 3_000,
      sender: { ghostId: 'ghost_1' },
      sealed: atLimit('e'),
    })
    expect(await ingest(t, [original, edit])).toEqual({ ackedThrough: 2 })
    expect((await messages(t))[0]).toMatchObject({ editEventId: 'edit1' })
  })

  it('stops a batch that would touch too much early, acknowledging what it applied', async () => {
    seq = 0
    const t = setup()
    const big = (tag: string) => ({ ...sealed(tag), ct: 'A'.repeat(349_524) })
    const originals = Array.from({ length: 30 }, (_, i) => message(`m${i}`, { sealed: big(`m${i}`) }))
    for (const original of originals) await ingest(t, [original])
    const edits = originals.map((original, i) =>
      event('edit', {
        portalId: 'portal_1',
        eventId: `edit${i}`,
        targetEventId: original.eventId,
        networkTs: 9_000,
        sender: { ghostId: 'ghost_1' },
        sealed: sealed(`e${i}`),
      }),
    )
    const first = await ingest(t, edits)
    expect('ackedThrough' in first && first.ackedThrough).toBeGreaterThan(30)
    expect('ackedThrough' in first && first.ackedThrough).toBeLessThan(60)
    // Sending the rest, as the gateway does, gets through all of them.
    let acked = (first as { ackedThrough: number }).ackedThrough
    for (let calls = 0; acked < 60 && calls < 30; calls++) {
      const next = await ingest(
        t,
        edits.filter((edit) => edit.seq > acked),
      )
      acked = (next as { ackedThrough: number }).ackedThrough
    }
    expect(acked).toBe(60)
    expect((await messages(t)).every((row) => row.editEventId)).toBe(true)
  })

  it('quarantines a login step or sender ID too big to store', async () => {
    seq = 0
    const t = setup()
    const result = await ingest(t, [
      message('e1', { sender: { ghostId: 'g'.repeat(300) } }),
      event('loginStep', {
        loginSessionId: 'x',
        step: { stepId: 's', type: 'userInput', instructions: '雪'.repeat(30_000) },
      }),
    ])
    expect(result).toEqual({ ackedThrough: 2 })
    expect((await quarantined(t)).map((row) => row.reason)).toEqual(['too_large', 'unknown_login_session'])
  })
})
