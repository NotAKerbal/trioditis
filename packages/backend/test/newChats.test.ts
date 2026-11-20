import { beforeEach, describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, heartbeat, sealed, setup, signIn, type T } from './setup'

// A fresh backend expects a host's events from the first sequence number.
let seq = 0
beforeEach(() => {
  seq = 0
})
async function ingest(t: T, events: Record<string, unknown>[]) {
  return await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: 'whatsapp-1',
    network: 'whatsapp',
    events: events.map((e) => ({ userId: 'user_a', loginId: 'login_a', at: 1_000, seq: ++seq, ...e })) as never,
  })
}

const requestId = (n: number) => `request-${String(n).padStart(8, '0')}`

async function connected(t: T) {
  const a = await signIn(t, 'user_a')
  await heartbeat(t)
  await ingest(t, [
    { type: 'loginState', state: 'CONNECTED' },
    { type: 'contact', ghostId: 'g_erin', sealed: sealed('erin') },
  ])
  const account = await t.run(async (ctx) => (await ctx.db.query('networkAccounts').first())!)
  return { a, networkAccountId: account._id }
}

async function claim(t: T) {
  return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 10, hostIds: ['whatsapp-1'] })
}

describe('new chats', () => {
  it('starts a chat from a sealed identifier and finds it from the bridge host’s answer', async () => {
    const t = setup()
    const { a, networkAccountId } = await connected(t)
    await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(1), sealedIdentifier: sealed('id') })
    // The same request again does nothing.
    await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(1), sealedIdentifier: sealed('id') })
    expect(await a.query(api.newChats.status, { requestId: requestId(1) })).toEqual({ state: 'pending' })
    const [command] = await claim(t)
    expect(command).toMatchObject({
      loginId: 'login_a',
      payload: { type: 'startChat', requestId: requestId(1) },
      sealed: sealed('id'),
    })
    await ingest(t, [{ type: 'chatStarted', requestId: requestId(1), portalId: 'p_erin' }])
    const chat = await t.run(async (ctx) => (await ctx.db.query('chats').first())!)
    expect(chat.portalId).toBe('p_erin')
    expect(await a.query(api.newChats.status, { requestId: requestId(1) })).toEqual({
      state: 'started',
      chatId: chat._id,
    })
  })

  it('starts a chat with a contact the person has, and reports why one couldn’t start', async () => {
    const t = setup()
    const { a, networkAccountId } = await connected(t)
    await expect(
      a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(2), ghostId: 'g_someone_else' }),
    ).rejects.toThrow(/contact doesn’t exist/)
    await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(2), ghostId: 'g_erin' })
    const [command] = await claim(t)
    expect(command!.payload).toEqual({ type: 'startChat', requestId: requestId(2), ghostId: 'g_erin' })
    await ingest(t, [{ type: 'chatStarted', requestId: requestId(2), error: 'not_found' }])
    expect(await a.query(api.newChats.status, { requestId: requestId(2) })).toEqual({
      state: 'failed',
      error: 'not_found',
    })
  })

  it('ends a request whose command the bridge host refused', async () => {
    const t = setup()
    const { a, networkAccountId } = await connected(t)
    await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(3), ghostId: 'g_erin' })
    const [command] = await claim(t)
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: command!.commandId,
      lease: command!.lease,
      accepted: false,
      error: 'unsupported',
    })
    expect(await a.query(api.newChats.status, { requestId: requestId(3) })).toEqual({
      state: 'failed',
      error: 'unsupported',
    })
  })

  it('refuses what it shouldn’t ask for, and an answer for another person or login', async () => {
    const t = setup()
    const { a, networkAccountId } = await connected(t)
    const b = await signIn(t, 'user_b')
    await expect(
      b.mutation(api.newChats.start, { networkAccountId, requestId: requestId(4), ghostId: 'g_erin' }),
    ).rejects.toThrow(/account doesn’t exist/)
    await expect(
      a.mutation(api.newChats.start, { networkAccountId, requestId: 'short', ghostId: 'g_erin' }),
    ).rejects.toThrow(/request ID/)
    await expect(
      a.mutation(api.newChats.start, {
        networkAccountId,
        requestId: requestId(4),
        ghostId: 'g_erin',
        sealedIdentifier: sealed(),
      }),
    ).rejects.toThrow(/contact or a sealed identifier/)
    await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(4), ghostId: 'g_erin' })
    expect(await b.query(api.newChats.status, { requestId: requestId(4) })).toBeNull()
    await ingest(t, [{ type: 'chatStarted', requestId: requestId(4), userId: 'user_b', portalId: 'p_x' }])
    const quarantine = await t.run(async (ctx) => await ctx.db.query('quarantine').collect())
    expect(quarantine).toHaveLength(1)
    expect(await a.query(api.newChats.status, { requestId: requestId(4) })).toEqual({ state: 'pending' })
  })

  it('limits how many chats a person can start a minute', async () => {
    const t = setup()
    const { a, networkAccountId } = await connected(t)
    for (let n = 0; n < 20; n++) {
      await a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(100 + n), ghostId: 'g_erin' })
    }
    await expect(
      a.mutation(api.newChats.start, { networkAccountId, requestId: requestId(200), ghostId: 'g_erin' }),
    ).rejects.toThrow(/Too many new chats/)
  })
})
