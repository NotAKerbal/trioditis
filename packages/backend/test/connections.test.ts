import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { accountHint } from '../convex/logins'
import { GATEWAY_SECRET, heartbeat, installNetworks, setup, signIn, type T } from './setup'

// Connecting and disconnecting accounts: telling accounts apart, bridge liveness as time
// passes, and a cancel that races the login finishing.

afterEach(() => {
  vi.useRealTimers()
})

let seq = 0
async function ingest(t: T, events: Record<string, unknown>[]) {
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: 'whatsapp-1',
    network: 'whatsapp',
    events: events.map((event) => ({ seq: ++seq, userId: 'user_a', at: Date.now(), ...event })) as never,
  })
}

const loginState = (loginId: string, state = 'CONNECTED') => ({ type: 'loginState', loginId, state })
const complete = (loginSessionId: Id<'loginSessions'>, loginId: string) => ({
  type: 'loginStep',
  loginId: '',
  loginSessionId,
  step: { stepId: 'done', type: 'complete', loginId },
})

async function claim(t: T) {
  return await t.mutation(api.gateway.claimCommands, { secret: GATEWAY_SECRET, limit: 10, hostIds: ['whatsapp-1'] })
}

async function lastSeen(t: T, hostId = 'whatsapp-1') {
  const hosts = await t.run(async (ctx) => await ctx.db.query('bridgeHosts').collect())
  return hosts.find((host) => host.hostId === hostId)!.lastSeenAt
}

async function logoutsQueued(t: T) {
  const rows = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
  return rows.filter((row) => row.payload.type === 'logout').map((row) => row.loginId)
}

describe('telling accounts apart', () => {
  it('shows a WhatsApp account by its number and others by the end of their ID', () => {
    expect(accountHint('whatsapp', '15550100')).toBe('+15550100')
    expect(accountHint('signal', '0f8e2c1a-9b7d-4c3e-8a61-2d5f9e4b7c10')).toBe('ID …7c10')
    // A WhatsApp ID that isn't a number isn't shown as one.
    expect(accountHint('whatsapp', 'lid-abcdef')).toBe('ID …cdef')
    expect(accountHint('signal', 'abc')).toBe('ID abc')
    expect(accountHint('signal', '')).toBe('')
  })

  it('gives each account its hint, and still not its login ID', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [loginState('15550100'), loginState('15550199')])
    const accounts = await a.query(api.logins.accounts, {})
    expect(accounts.map((row) => row.hint)).toEqual(['+15550100', '+15550199'])
    expect(accounts[0]).not.toHaveProperty('loginId')
  })
})

describe('bridge liveness', () => {
  it('gives when the bridge host was last heard from, for the client to judge as time passes', async () => {
    vi.useFakeTimers()
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    expect((await a.query(api.networks.health, {}))[0]).toMatchObject({ bridgeOnline: false, bridgeLastSeenAt: null })
    await heartbeat(t)
    const heardAt = await lastSeen(t)
    expect((await a.query(api.networks.health, {}))[0]).toMatchObject({ bridgeOnline: true, bridgeLastSeenAt: heardAt })
    vi.advanceTimersByTime(3 * 60_000)
    expect((await a.query(api.networks.health, {}))[0]).toMatchObject({ bridgeOnline: false, bridgeLastSeenAt: heardAt })
  })

  it('gives a login the time its bridge host was last heard from, before and after one takes it', async () => {
    vi.useFakeTimers()
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    const loginSessionId = await a.mutation(api.logins.start, { network: 'whatsapp' })
    expect((await a.query(api.logins.session, { loginSessionId }))!.hostLastSeenAt).toBeNull()
    await heartbeat(t)
    const heardAt = await lastSeen(t)
    expect((await a.query(api.logins.session, { loginSessionId }))!.hostLastSeenAt).toBe(heardAt)
    await claim(t)
    vi.advanceTimersByTime(60_000)
    // Another host coming up doesn't speak for a login the first one runs.
    await heartbeat(t, 'whatsapp-2')
    expect((await a.query(api.logins.session, { loginSessionId }))!.hostLastSeenAt).toBe(heardAt)
  })

  it('takes a step that says when its code expires', async () => {
    seq = 0
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    await heartbeat(t)
    const loginSessionId = await a.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    await ingest(t, [
      {
        type: 'loginStep',
        loginId: '',
        loginSessionId,
        step: { stepId: 'qr', type: 'displayAndWait', display: { type: 'qr', data: 'x', expiresAt: 5 }, expiresAt: 5 },
      },
    ])
    expect((await a.query(api.logins.session, { loginSessionId }))!.step).toMatchObject({
      display: { expiresAt: 5 },
      expiresAt: 5,
    })
  })
})

describe('cancelling a login', () => {
  async function started() {
    seq = 0
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    await heartbeat(t)
    const loginSessionId = await a.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    await ingest(t, [
      {
        type: 'loginStep',
        loginId: '',
        loginSessionId,
        step: { stepId: 'qr', type: 'displayAndWait', display: { type: 'qr', data: 'x' } },
      },
    ])
    return { t, a, loginSessionId }
  }

  it('ends the login at once, and asking again changes nothing', async () => {
    const { t, a, loginSessionId } = await started()
    expect(await a.mutation(api.logins.cancel, { loginSessionId })).toBe('cancelled')
    expect((await a.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
    expect(await a.mutation(api.logins.cancel, { loginSessionId })).toBe('cancelled')
    const cancels = (await t.run(async (ctx) => await ctx.db.query('outbox').collect())).filter(
      (row) => row.payload.type === 'loginCancel',
    )
    expect(cancels).toHaveLength(1)
  })

  it('says when the login had already finished', async () => {
    const { t, a, loginSessionId } = await started()
    await ingest(t, [complete(loginSessionId, '15550100'), loginState('15550100')])
    expect(await a.mutation(api.logins.cancel, { loginSessionId })).toBe('complete')
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ state: 'CONNECTED', logoutPending: false }])
    expect(await logoutsQueued(t)).toEqual([])
  })

  it('logs out a new account whose login finished after it was cancelled, step first', async () => {
    const { t, a, loginSessionId } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [complete(loginSessionId, '15550100'), loginState('15550100')])
    expect((await a.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ logoutPending: true }])
    expect(await logoutsQueued(t)).toEqual(['15550100'])
  })

  it('logs out a new account whose login finished after it was cancelled, account first', async () => {
    const { t, a, loginSessionId } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [loginState('15550100'), complete(loginSessionId, '15550100')])
    expect((await a.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ logoutPending: true }])
    expect(await logoutsQueued(t)).toEqual(['15550100'])
  })

  it('leaves an account the person already had when a cancelled reconnect finishes anyway', async () => {
    seq = 0
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    await heartbeat(t)
    await ingest(t, [loginState('15550100', 'BAD_CREDENTIALS')])
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    const loginSessionId = await a.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [complete(loginSessionId, '15550100'), loginState('15550100')])
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ state: 'CONNECTED', logoutPending: false }])
    expect(await logoutsQueued(t)).toEqual([])
  })
})

describe('disconnecting', () => {
  it('says whether a disconnect was asked for, is already on its way, or wasn’t needed', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [loginState('15550100'), loginState('15550199', 'LOGGED_OUT')])
    const [first, second] = await a.query(api.logins.accounts, {})
    expect(await a.mutation(api.logins.logout, { networkAccountId: first!._id })).toBe('queued')
    expect(await a.mutation(api.logins.logout, { networkAccountId: first!._id })).toBe('pending')
    expect(await a.mutation(api.logins.logout, { networkAccountId: second!._id })).toBe('loggedOut')
    expect(await logoutsQueued(t)).toEqual(['15550100'])
  })
})
