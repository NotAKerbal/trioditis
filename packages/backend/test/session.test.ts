import { describe, expect, it } from 'vitest'
import { api, components } from '../convex/_generated/api'
import { setup, signIn, type T } from './setup'

const ORIGIN = 'https://trioditis.test'

async function sessionIds(t: T) {
  return await t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'session',
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: { _id: string; userId: string; token: string }[] }
    return page.map((session) => session.token).sort()
  })
}

async function endSession(t: T, body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return await t.fetch('/api/auth/end-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('members.me', () => {
  it('gives the signed-in account and session with its membership', async () => {
    const t = setup()
    expect(await t.query(api.members.me, {})).toBeNull()

    const sam = await signIn(t, 'sam', 'admin')
    const me = await sam.query(api.members.me, {})
    expect(me).toEqual({
      userId: 'sam',
      sessionId: expect.any(String),
      member: { userId: 'sam', role: 'admin', identityKid: 'K'.repeat(22) },
    })

    // Signed in, but not a member: the account is still named, so the app signs out that one.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', 'sam'))
        .unique()
      await ctx.db.delete(member!._id)
    })
    expect(await sam.query(api.members.me, {})).toEqual({ userId: 'sam', sessionId: me!.sessionId, member: null })
  })

  it('is null once the session has ended', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam')
    expect((await endSession(t, { token: 'token-sam' })).status).toBe(200)
    expect(await sam.query(api.members.me, {})).toBeNull()
  })
})

describe('end-session', () => {
  it('ends exactly the given session, whoever the cookie signs in', async () => {
    const t = setup()
    await signIn(t, 'alex')
    const bea = await signIn(t, 'bea')
    // Another tab signed in as Bea since this one read Alex's token.
    const response = await endSession(
      t,
      { token: 'token-alex' },
      {
        origin: ORIGIN,
        cookie: 'better-auth.session_token=token-bea.signature',
      },
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: 'ended' })
    // No cookie at all, not even an expired one, so Bea's sign-in is left alone.
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await sessionIds(t)).toEqual(['token-bea'])
    expect(await bea.query(api.members.me, {})).toMatchObject({ userId: 'bea' })
  })

  it('answers absent when there is no such session', async () => {
    const t = setup()
    await signIn(t, 'alex')
    expect(await (await endSession(t, { token: 'token-alex' })).json()).toEqual({ result: 'ended' })
    const again = await endSession(t, { token: 'token-alex' })
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ result: 'absent' })
    expect(await (await endSession(t, { token: 'never-issued' })).json()).toEqual({ result: 'absent' })
  })

  it('refuses a missing or untrusted origin, with or without a cookie, and changes nothing', async () => {
    const t = setup()
    await signIn(t, 'alex')
    for (const headers of <Record<string, string>[]>[
      {},
      { origin: 'null' },
      { origin: 'https://elsewhere.test' },
      { origin: 'https://elsewhere.test', cookie: 'better-auth.session_token=x' },
    ]) {
      const response = await endSession(t, { token: 'token-alex' }, headers)
      expect(response.status).toBe(403)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(await sessionIds(t)).toEqual(['token-alex'])
  })

  it('refuses a request without a usable token', async () => {
    const t = setup()
    await signIn(t, 'alex')
    for (const body of [{}, { token: '' }, { token: 7 }, { token: 'x'.repeat(257) }]) {
      expect((await endSession(t, body)).status).toBe(400)
    }
    expect(await sessionIds(t)).toEqual(['token-alex'])
  })
})
