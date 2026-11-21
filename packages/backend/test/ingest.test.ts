import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, sealed, setup, signIn, type T } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }

afterEach(() => {
  vi.useRealTimers()
})
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

  it('takes a host that says it is stopping offline at once', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [message('e1')])
    const lastSeen = () => t.run(async (ctx) => (await ctx.db.query('bridgeHosts').first())?.lastSeenAt)
    expect(await lastSeen()).toBeGreaterThan(0)
    expect(
      await t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, ...HOST, events: [], stopping: true }),
    ).toEqual({
      ackedThrough: 1,
    })
    expect(await lastSeen()).toBe(0)
    // The next heartbeat, from the host started again, brings it back.
    await ingest(t, [])
    expect(await lastSeen()).toBeGreaterThan(0)
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
    vi.useFakeTimers()
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
    await t.finishAllScheduledFunctions(vi.runAllTimers)
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

  it('deletes a message with many reactions, cleaning the reactions up afterwards', async () => {
    vi.useFakeTimers()
    seq = 0
    const t = setup()
    await ingest(t, [message('e1')])
    const { _id: messageId, chatId } = (await messages(t))[0]!
    await t.run(async (ctx) => {
      for (let i = 0; i < 500; i++) {
        await ctx.db.insert('reactions', {
          userId: 'user_a',
          chatId,
          messageId,
          senderKey: `ghost:g${i}`,
          key: '👍',
          eventId: `r${i}`,
          addedAt: 1,
          networkTs: 1,
        })
      }
    })
    const redaction = event('redaction', {
      portalId: 'portal_1',
      targetEventId: 'e1',
      sender: { ghostId: 'ghost_1' },
      networkTs: 3_000,
    })
    expect(await ingest(t, [redaction])).toEqual({ ackedThrough: 2 })
    expect((await messages(t))[0]!.redactedAt).toBe(3_000)
    // Until they're gone, a marker hides them from `messages.reactions`.
    const markers = async () => await t.run(async (ctx) => await ctx.db.query('reactionCleanups').collect())
    expect(await markers()).toHaveLength(1)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run(async (ctx) => await ctx.db.query('reactions').collect())).toHaveLength(0)
    expect(await markers()).toHaveLength(0)
    vi.useRealTimers()
  })

  it('caps login form field IDs and keeps no oversized user ID in quarantine', async () => {
    seq = 0
    const t = setup()
    const step = event('loginStep', {
      loginSessionId: 'x',
      step: { stepId: 's', type: 'userInput', fields: [{ id: 'f'.repeat(300), type: 'text', name: 'Name' }] },
    })
    const longUser = { ...message('e2'), userId: 'u'.repeat(300) }
    expect(await ingest(t, [step, longUser])).toEqual({ ackedThrough: 2 })
    expect((await quarantined(t)).map((row) => [row.reason, row.userId])).toEqual([
      ['too_large', 'user_a'],
      ['too_large', ''],
    ])
  })

  it('counts mentions, wakes a snoozed chat on a new message, and records requests', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [event('chat', { portalId: 'portal_1', kind: 'dm', sealed: sealed('c'), isRequest: true })])
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query('chats').first())!
      await ctx.db.patch(chat._id, { snoozedUntil: Date.now() + 60_000, woke: false })
    })
    await ingest(t, [message('e1', { mentionsMe: true }), message('e2')])
    expect(await chat(t)).toMatchObject({ isRequest: true, mentionCount: 1, unreadCount: 2, woke: true })
    // Once accepted, a later description of the chat doesn't make it a request again.
    await t.run(async (ctx) => {
      await ctx.db.patch((await ctx.db.query('chats').first())!._id, { isRequest: false })
    })
    await ingest(t, [event('chat', { portalId: 'portal_1', kind: 'dm', sealed: sealed('c2'), isRequest: true })])
    expect((await chat(t)).isRequest).toBe(false)
    await ingest(t, [
      event('receipt', { portalId: 'portal_1', sender: { self: true }, upToEventId: 'e2', networkTs: 9_000 }),
    ])
    expect(await chat(t)).toMatchObject({ unreadCount: 0, mentionCount: 0 })
  })

  it('quarantines chat metadata over its cap', async () => {
    seq = 0
    const t = setup()
    const big = { ...sealed('meta'), ct: 'A'.repeat(12_000) }
    expect(await ingest(t, [event('chat', { portalId: 'portal_1', kind: 'dm', sealed: big }), message('e2')])).toEqual({
      ackedThrough: 2,
    })
    expect(await quarantined(t)).toMatchObject([{ seq: 1, reason: 'too_large' }])
  })

  it('keeps messages newer than a delayed receipt unread', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1', { networkTs: 1_000 }),
      message('e2', { networkTs: 2_000 }),
      message('e3', { networkTs: 3_000 }),
      event('receipt', { portalId: 'portal_1', sender: { self: true }, upToEventId: 'e1', networkTs: 1_500 }),
    ])
    expect((await chat(t)).unreadCount).toBe(2)
  })

  it('recounts unread and mentions after a delayed read receipt', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1', { networkTs: 1_000, mentionsMe: true }),
      message('e2', { networkTs: 2_000, mentionsMe: true }),
      message('e3', { networkTs: 3_000 }),
    ])
    expect(await chat(t)).toMatchObject({ unreadCount: 3, mentionCount: 2 })
    await ingest(t, [
      event('receipt', { portalId: 'portal_1', sender: { self: true }, upToEventId: 'e1', networkTs: 1_500 }),
    ])
    expect(await chat(t)).toMatchObject({ unreadCount: 2, mentionCount: 1 })
  })

  it('puts chats ingest creates in the right list', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1'),
      event('chat', { portalId: 'portal_2', kind: 'dm', sealed: sealed('c2'), isRequest: true }),
    ])
    const views = async () =>
      Object.fromEntries(
        (await t.run(async (ctx) => await ctx.db.query('chats').collect())).map((row) => [row.portalId, row.view]),
      )
    expect(await views()).toEqual({ portal_1: 'inbox', portal_2: 'requests' })
    await t.run(async (ctx) => {
      const chat = (await ctx.db.query('chats').collect()).find((row) => row.portalId === 'portal_1')!
      await ctx.db.patch(chat._id, { snoozedUntil: Date.now() + 60_000, woke: false, archived: true, view: 'snoozed' })
    })
    // A new message wakes the snooze and brings the chat back to the inbox.
    await ingest(t, [message('e2')])
    expect((await views()).portal_1).toBe('inbox')
  })

  it('refuses events for a network the server runs no bridge host for', async () => {
    seq = 0
    const t = setup()
    await expect(
      t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, hostId: 'telegram-1', network: 'telegram', events: [] }),
    ).rejects.toThrow(/not enabled/)
  })
})

describe('read watermark and receipts', () => {
  const selfReceipt = (upToEventId: string, networkTs: number) =>
    event('receipt', { portalId: 'portal_1', sender: { self: true }, upToEventId, networkTs })
  const theirReceipt = (upToEventId: string, networkTs: number) =>
    event('receipt', { portalId: 'portal_1', sender: { ghostId: 'ghost_1' }, upToEventId, networkTs })
  const own = (eventId: string, networkTs: number) => message(eventId, { networkTs, sender: { self: true } })

  async function deliveries(t: T) {
    return Object.fromEntries((await messages(t)).map((row) => [row.eventId, row.delivery]))
  }

  it('doesn’t count a late message from before what the person read here', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [message('e1', { networkTs: 1_000 }), message('e3', { networkTs: 3_000, mentionsMe: true })])
    await a.mutation(api.chats.markRead, { chatId: (await chat(t))._id })
    // An older message the network delivered late, then a new one.
    await ingest(t, [message('e2', { networkTs: 2_000, mentionsMe: true }), message('e4', { networkTs: 4_000 })])
    expect(await chat(t)).toMatchObject({ unreadCount: 1, mentionCount: 0 })
  })

  it('moves the unread revision on with every message counted, so a repeated count still differs', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [message('e1', { networkTs: 1_000 }), message('e5', { networkTs: 5_000 })])
    const chatId = (await chat(t))._id
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ unreadCount: 2, unreadRev: 2 })
    await a.mutation(api.chats.markRead, { chatId })
    // The person's own message, then a late one that sorts behind it but after what was read.
    await ingest(t, [own('o7', 7_000), message('e6', { networkTs: 6_000 })])
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ unreadCount: 1, unreadRev: 3 })
    await a.mutation(api.chats.markRead, { chatId })
    // Another after the mark: the count is 1 again, the revision isn't.
    await ingest(t, [message('e8', { networkTs: 8_000 })])
    expect(await a.query(api.chats.get, { chatId })).toMatchObject({ unreadCount: 1, unreadRev: 4 })
  })

  it('doesn’t count a late message from before the person’s own receipt', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [
      message('e1', { networkTs: 1_000 }),
      message('e3', { networkTs: 3_000 }),
      selfReceipt('e3', 3_100),
    ])
    expect((await chat(t)).unreadCount).toBe(0)
    await ingest(t, [message('e2', { networkTs: 2_000 })])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('doesn’t recount from a receipt older than what the person read here', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [message('e1', { networkTs: 1_000 }), message('e2', { networkTs: 2_000 })])
    await a.mutation(api.chats.markRead, { chatId: (await chat(t))._id })
    // The phone's receipt for e1 lands after the person read both here.
    await ingest(t, [selfReceipt('e1', 1_500)])
    expect((await chat(t)).unreadCount).toBe(0)
  })

  it('marks the person’s own messages read up to someone else’s receipt, never back', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [own('o1', 1_000), message('e2', { networkTs: 2_000 }), own('o3', 3_000), own('o4', 4_000)])
    await ingest(t, [theirReceipt('o3', 3_500)])
    expect(await deliveries(t)).toEqual({ o1: 'read', e2: undefined, o3: 'read', o4: undefined })
    // An older receipt from them changes nothing; a newer one carries on.
    await ingest(t, [theirReceipt('o1', 3_400), theirReceipt('o4', 4_500)])
    expect(await deliveries(t)).toEqual({ o1: 'read', e2: undefined, o3: 'read', o4: 'read' })
  })

  it('moves a send’s delivery forward on a receipt but leaves a pending copy alone', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [own('o1', 1_000), message('e2', { networkTs: 2_000 })])
    await t.run(async (ctx) => {
      const rows = await ctx.db.query('messages').collect()
      const o1 = rows.find((row) => row.eventId === 'o1')!
      await ctx.db.patch(o1._id, { delivery: 'delivered' })
      // A send still waiting for its echo, sorted before the receipt: the network doesn't have it.
      await ctx.db.insert('messages', {
        userId: 'user_a',
        chatId: o1.chatId,
        network: 'whatsapp',
        eventId: 'pending:x',
        networkTs: 1_500,
        sortKey: '0000000000001500:pending:x',
        sender: { self: true },
        sealed: sealed('p'),
        sealedObjectId: 'x',
        historical: false,
        delivery: 'unknown',
      })
    })
    await ingest(t, [theirReceipt('e2', 2_100)])
    expect(await deliveries(t)).toEqual({ o1: 'read', e2: undefined, 'pending:x': 'unknown' })
  })

  it('marks the person’s own message read when it arrives late behind someone’s receipt', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [own('o1', 1_000), own('o3', 3_000), theirReceipt('o3', 3_500)])
    // Sent from the phone at 2,000, but the network delivered it to the bridge after the receipt.
    await ingest(t, [own('o2', 2_000), own('o4', 4_000)])
    expect(await deliveries(t)).toEqual({ o1: 'read', o2: 'read', o3: 'read', o4: undefined })
  })

  it('looks past one already read for older ones the receipt covers', async () => {
    seq = 0
    const t = setup()
    await ingest(t, [own('o1', 1_000), own('o2', 2_000), own('o3', 3_000)])
    // A status already said o2 was read; o1, before it, wasn't.
    await t.run(async (ctx) => {
      const o2 = (await ctx.db.query('messages').collect()).find((row) => row.eventId === 'o2')!
      await ctx.db.patch(o2._id, { delivery: 'read' })
    })
    await ingest(t, [theirReceipt('o3', 3_500)])
    expect(await deliveries(t)).toEqual({ o1: 'read', o2: 'read', o3: 'read' })
  })

  it('carries on past one transaction’s worth of messages', async () => {
    vi.useFakeTimers()
    seq = 0
    const t = setup()
    await ingest(t, [own('o0', 0)])
    await t.run(async (ctx) => {
      const { chatId } = (await ctx.db.query('messages').first())!
      for (let i = 1; i <= 150; i++) {
        const eventId = `o${i}`
        await ctx.db.insert('messages', {
          userId: 'user_a',
          chatId,
          network: 'whatsapp',
          eventId,
          networkTs: i,
          sortKey: `${String(i).padStart(16, '0')}:${eventId}`,
          sender: { self: true },
          sealed: sealed(eventId),
          sealedObjectId: eventId,
          historical: false,
        })
      }
    })
    await ingest(t, [theirReceipt('o150', 200)])
    const before = Object.values(await deliveries(t)).filter((delivery) => delivery === 'read').length
    expect(before).toBeLessThan(151)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(Object.values(await deliveries(t)).every((delivery) => delivery === 'read')).toBe(true)
  })
})
