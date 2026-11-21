import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../convex/_generated/api'
import type { Doc, Id } from '../convex/_generated/dataModel'
import { GATEWAY_SECRET, setup, signIn, type T } from './setup'

afterEach(() => {
  vi.useRealTimers()
})

const cookiesStep = (stepId: string, browser = true): NonNullable<Doc<'loginSessions'>['step']> => ({
  stepId,
  type: 'cookies',
  cookies: { url: 'https://www.messenger.com/', fields: [{ id: 'xs', required: true }], browser },
})

async function aLogin(t: T, userId: string, patch: Partial<Doc<'loginSessions'>> = {}) {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert('loginSessions', {
        userId,
        network: 'whatsapp',
        state: 'active',
        step: cookiesStep('step_1'),
        hostId: 'whatsapp-1',
        updatedAt: Date.now(),
        ...patch,
      }),
  )
}

const redeem = (t: T, ticket: string) => t.mutation(api.gateway.redeemSigninTicket, { secret: GATEWAY_SECRET, ticket })

describe('sign-in browser tickets', () => {
  it('issues a ticket the gateway redeems once', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    const loginSessionId = await aLogin(t, 'user_a')
    const { ticket, admission } = await alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The admission the gateway checks before taking the socket: signed with its secret.
    const [person, expiresAt, mac] = admission.split('.')
    expect(person).toMatch(/^[0-9a-f]{32}$/)
    expect(Number(expiresAt)).toBeGreaterThan(Date.now())
    expect(mac).toBe(
      createHmac('sha256', GATEWAY_SECRET)
        .update(`login-browser-admission\n${person}.${expiresAt}`)
        .digest('base64url'),
    )
    expect(admission).not.toContain(ticket)
    // Only its hash is stored.
    const rows = await t.run(async (ctx) => await ctx.db.query('signinTickets').collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tokenHash).not.toContain(ticket)

    expect(await redeem(t, ticket)).toEqual({
      loginSessionId,
      userId: 'user_a',
      hostId: 'whatsapp-1',
      stepId: 'step_1',
    })
    expect(await redeem(t, ticket)).toBeNull()
  })

  it('refuses a step that is not a browser step, or someone else’s login', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    const bob = await signIn(t, 'user_b')
    const loginSessionId = await aLogin(t, 'user_a')
    await expect(alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'other' })).rejects.toThrow()
    await expect(bob.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })).rejects.toThrow()

    const pasted = await aLogin(t, 'user_a', { step: cookiesStep('step_2', false) })
    await expect(alice.mutation(api.logins.openBrowser, { loginSessionId: pasted, stepId: 'step_2' })).rejects.toThrow()
    const unrouted = await aLogin(t, 'user_a', { hostId: undefined })
    await expect(
      alice.mutation(api.logins.openBrowser, { loginSessionId: unrouted, stepId: 'step_1' }),
    ).rejects.toThrow()
    const over = await aLogin(t, 'user_a', { state: 'complete' })
    await expect(alice.mutation(api.logins.openBrowser, { loginSessionId: over, stepId: 'step_1' })).rejects.toThrow()
  })

  it('keeps only the newest ticket', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    const loginSessionId = await aLogin(t, 'user_a')
    const { ticket: first } = await alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })
    const { ticket: second } = await alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })
    expect(await redeem(t, first)).toBeNull()
    expect(await redeem(t, second)).not.toBeNull()
  })

  it('refuses an expired ticket, or one whose step is over', async () => {
    vi.useFakeTimers()
    const t = setup()
    const alice = await signIn(t, 'user_a')
    const loginSessionId: Id<'loginSessions'> = await aLogin(t, 'user_a')
    const { ticket: stale } = await alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })
    vi.advanceTimersByTime(61_000)
    expect(await redeem(t, stale)).toBeNull()

    const { ticket: moved } = await alice.mutation(api.logins.openBrowser, { loginSessionId, stepId: 'step_1' })
    await t.run(async (ctx) => await ctx.db.patch(loginSessionId, { step: cookiesStep('step_2') }))
    expect(await redeem(t, moved)).toBeNull()
  })

  it('needs the gateway secret', async () => {
    const t = setup()
    await expect(t.mutation(api.gateway.redeemSigninTicket, { secret: 'wrong', ticket: 'x' })).rejects.toThrow()
  })
})
