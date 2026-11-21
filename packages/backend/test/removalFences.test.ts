import { describe, expect, it } from 'vitest'
import { api, components, internal } from '../convex/_generated/api'
import { GATEWAY_SECRET, heartbeat, setup, signIn, type T } from './setup'

/** A Better Auth user, as sign-up makes one. */
async function user(t: T, email: string) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const row = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: 'user', data: { name: email, email, emailVerified: false, createdAt: now, updatedAt: now } },
    })) as { _id: string }
    return row._id
  })
}

const claim = (t: T) =>
  t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 10, hostIds: ['whatsapp-1'] })

describe('after a member is removed', () => {
  it('hands the bridge host only their logouts; their sends are settled, never sent', async () => {
    const t = setup()
    const admin = await signIn(t, await user(t, 'admin@x.test'), 'admin')
    const samId = await user(t, 'sam@x.test')
    await signIn(t, samId)
    await heartbeat(t)
    const ids = await t.run(async (ctx) => {
      await ctx.db.insert('networkAccounts', {
        userId: samId,
        network: 'whatsapp',
        loginId: 'l_sam',
        hostId: 'whatsapp-1',
        state: 'CONNECTED',
        updatedAt: 1,
      })
      const base = { userId: samId, network: 'whatsapp' as const, loginId: 'l_sam', createdAt: Date.now() }
      // Never handed over yet.
      const queued = await ctx.db.insert('outbox', {
        ...base,
        payload: { type: 'send', portalId: 'p', clientMessageId: 'c1' },
        clientMessageId: 'c1',
        state: 'queued',
        delivery: 'queued',
        attempts: 0,
        expiresAt: Date.now() + 60_000,
      })
      // Handed over once, its lease run out: it may have gone out.
      const inFlight = await ctx.db.insert('outbox', {
        ...base,
        payload: { type: 'send', portalId: 'p2', clientMessageId: 'c2' },
        clientMessageId: 'c2',
        state: 'claimed',
        delivery: 'claimed',
        attempts: 1,
        hostId: 'whatsapp-1',
        leaseUntil: Date.now() - 1,
        expiresAt: Date.now() + 60_000,
      })
      return { queued, inFlight }
    })

    await admin.mutation(api.members.removeMember, { userId: samId })
    const claimed = await claim(t)
    expect(claimed.map((c) => c.payload.type)).toEqual(['logout'])
    const rows = await t.run(async (ctx) => ({
      queued: await ctx.db.get(ids.queued),
      inFlight: await ctx.db.get(ids.inFlight),
    }))
    expect(rows.queued).toMatchObject({ state: 'expired', delivery: 'failed' })
    expect(rows.inFlight).toMatchObject({ state: 'expired', delivery: 'unknown' })
    // Nothing comes back for them on the next claim either.
    expect(await claim(t)).toEqual([])
  })

  it('queues a logout that ran out of time again, and lets an admin see and retry the cleanup', async () => {
    const t = setup()
    const admin = await signIn(t, await user(t, 'admin@x.test'), 'admin')
    const samId = await user(t, 'sam@x.test')
    await signIn(t, samId)
    await t.run(async (ctx) => {
      await ctx.db.insert('networkAccounts', {
        userId: samId,
        network: 'whatsapp',
        loginId: 'l_sam',
        hostId: 'whatsapp-1',
        state: 'CONNECTED',
        updatedAt: 1,
      })
    })
    await admin.mutation(api.members.removeMember, { userId: samId })
    expect(await admin.query(api.members.removedCleanup, {})).toMatchObject([
      { userId: samId, email: 'sam@x.test', accounts: 1, pending: 1, failed: 0 },
    ])

    // No bridge host took it before its deadline: it's expired, and queued again.
    const first = await t.run(async (ctx) => (await ctx.db.query('outbox').collect()).find((c) => c.userId === samId)!)
    await t.run(async (ctx) => {
      await ctx.db.patch(first._id, { expiresAt: Date.now() - 1 })
    })
    await heartbeat(t)
    await claim(t)
    // The new logout goes out on the next claim.
    expect((await claim(t)).map((c) => c.payload.type)).toEqual(['logout'])
    const logouts = await t.run(async (ctx) =>
      (await ctx.db.query('outbox').collect()).filter((c) => c.payload.type === 'logout'),
    )
    expect(logouts.map((c) => c.state).sort()).toEqual(['claimed', 'expired'])
    const account = await t.run(async (ctx) => (await ctx.db.query('networkAccounts').collect())[0]!)
    expect(account.logoutPending).toBe(true)

    // A bridge host refusing it leaves it failed, for an admin to retry.
    const live = logouts.find((c) => c.state === 'claimed')!
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: live._id,
      lease: live.attempts,
      accepted: false,
      error: 'invalid_command',
    })
    expect(await admin.query(api.members.removedCleanup, {})).toMatchObject([{ pending: 0, failed: 1 }])
    expect(await admin.mutation(api.members.retryCleanup, { userId: samId })).toEqual({ queued: 1, left: 1 })
    expect(await admin.query(api.members.removedCleanup, {})).toMatchObject([{ pending: 1, failed: 0 }])

    // Once the account reports logged out, the cleanup is done.
    await t.run(async (ctx) => {
      await ctx.db.patch(account._id, { state: 'LOGGED_OUT', logoutPending: false })
    })
    expect(await admin.query(api.members.removedCleanup, {})).toEqual([])
    expect(await admin.mutation(api.members.retryCleanup, { userId: samId })).toEqual({ queued: 0, left: 0 })
  })

  it('tracks an account from a login that finished after the removal, with a retry if its logout fails', async () => {
    const t = setup()
    const admin = await signIn(t, await user(t, 'admin@x.test'), 'admin')
    const samId = await user(t, 'sam@x.test')
    await signIn(t, samId)
    // No account yet, only a login under way.
    await t.run(async (ctx) => {
      await ctx.db.insert('loginSessions', { userId: samId, network: 'whatsapp', state: 'active', updatedAt: 1 })
    })
    await admin.mutation(api.members.removeMember, { userId: samId })
    // The login finishes on the bridge host anyway.
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      events: [{ seq: 1, type: 'loginState', userId: samId, loginId: 'late', at: Date.now(), state: 'CONNECTED' }],
    })
    expect(await admin.query(api.members.removedCleanup, {})).toMatchObject([
      { userId: samId, email: 'sam@x.test', accounts: 1, pending: 1 },
    ])
    const logout = (await claim(t)).find((c) => c.payload.type === 'logout')!
    expect(logout).toMatchObject({ loginId: 'late' })
    await t.mutation(api.gateway.commandResult, {
      secret: GATEWAY_SECRET,
      commandId: logout.commandId,
      lease: logout.lease,
      accepted: false,
      error: 'invalid_command',
    })
    expect(await admin.query(api.members.removedCleanup, {})).toMatchObject([{ failed: 1 }])
    expect(await admin.mutation(api.members.retryCleanup, { userId: samId })).toEqual({ queued: 1, left: 1 })
  })

  it('refuses an agent connection approved before the removal, and revokes it on first use', async () => {
    const t = setup()
    const samId = await user(t, 'sam@x.test')
    await signIn(t, samId)
    const { apiKey } = await t.action(internal.mcp.createApiKeyForUser, { userId: samId, name: 'agent' })
    // As removal leaves it: no membership. (The token was issued before, or traded for after.)
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', samId))
        .unique()
      await ctx.db.delete(member!._id)
    })
    const response = await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_networks', arguments: {} },
      }),
    })
    expect(response.status).toBe(401)
    expect(await t.query(components.mcp.grants.list, { userId: samId })).toEqual([])
    expect(await t.query(internal.mcp.networksForUser, { userId: samId })).toEqual([])
  })
})
