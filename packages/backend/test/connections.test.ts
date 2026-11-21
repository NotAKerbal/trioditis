import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { accountHint } from '../convex/logins'
import { GATEWAY_SECRET, heartbeat, installNetworks, sealed, setup, signIn, type T } from './setup'

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
  it('shows the end of the login ID, which never reads as a number', () => {
    // The bridge host's login IDs are keyed hashes, like these.
    expect(accountHint('l_Q2x9aZ0bXy4mN7pR3sT1uV')).toBe('ID …T1uV')
    expect(accountHint('abc')).toBe('ID abc')
    expect(accountHint('')).toBe('')
  })

  it('gives each account its hint and the bridge host’s sealed one, and still not its login ID', async () => {
    seq = 0
    const t = setup()
    const a = await signIn(t, 'user_a')
    const sealedHint = sealed('hint')
    await ingest(t, [
      { ...loginState('l_AAAAAAAAAAAAAAAAAAAAAAAA'), sealed: sealedHint },
      loginState('l_BBBBBBBBBBBBBBBBBBBBBBBB'),
    ])
    const accounts = await a.query(api.logins.accounts, {})
    expect(accounts.map((row) => row.hint)).toEqual(['ID …AAAA', 'ID …BBBB'])
    expect(accounts[0]!.sealedMeta).toEqual({ sealed: sealedHint, objectId: 'l_AAAAAAAAAAAAAAAAAAAAAAAA' })
    expect(accounts[1]!.sealedMeta).toBeNull()
    expect(accounts[0]).not.toHaveProperty('loginId')
    // A later report without one keeps what the account had.
    await ingest(t, [loginState('l_AAAAAAAAAAAAAAAAAAAAAAAA', 'TRANSIENT_DISCONNECT')])
    expect((await a.query(api.logins.accounts, {}))[0]!.sealedMeta).not.toBeNull()
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
    expect((await a.query(api.networks.health, {}))[0]).toMatchObject({
      bridgeOnline: false,
      bridgeLastSeenAt: heardAt,
    })
  })

  it('gives a login the time its bridge host was last heard from, before and after one takes it', async () => {
    vi.useFakeTimers()
    const t = setup()
    await installNetworks(t)
    const a = await signIn(t, 'user_a')
    const loginSessionId = await a.mutation(api.logins.start, { network: 'whatsapp' })
    expect(await a.query(api.logins.session, { loginSessionId })).toMatchObject({
      hostLastSeenAt: null,
      hostOnline: false,
    })
    await heartbeat(t)
    const heardAt = await lastSeen(t)
    expect((await a.query(api.logins.session, { loginSessionId }))!.hostLastSeenAt).toBe(heardAt)
    await claim(t)
    vi.advanceTimersByTime(60_000)
    // Another host coming up doesn't speak for a login the first one runs.
    await heartbeat(t, 'whatsapp-2')
    expect((await a.query(api.logins.session, { loginSessionId }))!.hostLastSeenAt).toBe(heardAt)
    vi.advanceTimersByTime(2 * 60_000)
    expect(await a.query(api.logins.session, { loginSessionId })).toMatchObject({
      hostLastSeenAt: heardAt,
      hostOnline: false,
    })
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

  it('keeps a new account whose login finished after it was cancelled, flagged, step first', async () => {
    const { t, a, loginSessionId } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [complete(loginSessionId, 'l_late'), loginState('l_late')])
    expect((await a.query(api.logins.session, { loginSessionId }))!.state).toBe('cancelled')
    expect(await a.query(api.logins.accounts, {})).toMatchObject([
      { state: 'CONNECTED', connectedAfterCancel: true, logoutPending: false },
    ])
    expect(await logoutsQueued(t)).toEqual([])
  })

  it('keeps a new account whose login finished after it was cancelled, flagged, account first', async () => {
    const { t, a, loginSessionId } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [loginState('l_late'), complete(loginSessionId, 'l_late')])
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ connectedAfterCancel: true, logoutPending: false }])
    expect(await logoutsQueued(t)).toEqual([])
  })

  it('stops asking once the person keeps it, or disconnects it', async () => {
    const { t, a, loginSessionId } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId })
    await ingest(t, [complete(loginSessionId, 'l_late'), loginState('l_late')])
    const [account] = await a.query(api.logins.accounts, {})
    await a.mutation(api.logins.keep, { networkAccountId: account!._id })
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ connectedAfterCancel: false }])
    expect(await logoutsQueued(t)).toEqual([])

    const second = await started()
    await second.a.mutation(api.logins.cancel, { loginSessionId: second.loginSessionId })
    await ingest(second.t, [complete(second.loginSessionId, 'l_late'), loginState('l_late')])
    const [flagged] = await second.a.query(api.logins.accounts, {})
    await second.a.mutation(api.logins.logout, { networkAccountId: flagged!._id })
    expect(await second.a.query(api.logins.accounts, {})).toMatchObject([
      { connectedAfterCancel: false, logoutPending: true },
    ])
  })

  it('clears the flag when a later login of theirs connects the account normally', async () => {
    const { t, a, loginSessionId: first } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId: first })
    await ingest(t, [complete(first, 'l_same'), loginState('l_same')])
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ connectedAfterCancel: true }])
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    const retry = await a.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    await ingest(t, [complete(retry, 'l_same'), loginState('l_same')])
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ connectedAfterCancel: false }])
    expect(await logoutsQueued(t)).toEqual([])
  })

  it('doesn’t flag the account when a retry connected it before the cancelled login’s late completion', async () => {
    const { t, a, loginSessionId: first } = await started()
    await a.mutation(api.logins.cancel, { loginSessionId: first })
    vi.useFakeTimers()
    vi.advanceTimersByTime(1000)
    const retry = await a.mutation(api.logins.start, { network: 'whatsapp' })
    await claim(t)
    await ingest(t, [complete(retry, 'l_same'), loginState('l_same')])
    await ingest(t, [complete(first, 'l_same')])
    expect(await a.query(api.logins.accounts, {})).toMatchObject([{ connectedAfterCancel: false }])
    expect(await logoutsQueued(t)).toEqual([])
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
