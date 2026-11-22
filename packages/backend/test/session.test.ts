import { describe, expect, it } from 'vitest'
import { api, components } from '../convex/_generated/api'
import { SETUP_TOKEN, setup, signIn, type T } from './setup'

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

describe('end-session with real sign-ins', () => {
  // Better Auth's own sign-up, session cookie, getSession and Convex token, so the IDs and the
  // cookie handling are the real ones, not seeded rows.
  async function signUp(t: T, email: string, invite: string) {
    const response = await t.fetch('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-trioditis-invite': invite },
      body: JSON.stringify({ email, password: 'a-long-test-password', name: email }),
    })
    expect(response.status).toBe(200)
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const session = (await (
      await t.fetch('/api/auth/get-session', { headers: { cookie, origin: ORIGIN } })
    ).json()) as {
      session: { id: string; token: string }
    }
    const { token: jwt } = (await (
      await t.fetch('/api/auth/convex/token', { headers: { cookie, origin: ORIGIN } })
    ).json()) as { token: string }
    const claims = JSON.parse(atob(jwt.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/'))) as {
      sub: string
      sessionId: string
    }
    return {
      cookie,
      session: session.session,
      client: t.withIdentity({ subject: claims.sub, sessionId: claims.sessionId }),
    }
  }

  it('ends one account’s session from a tab now signed in as another', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    const { token: invite } = await alex.client.mutation(api.members.invite, {
      email: 'bea@example.com',
      role: 'member',
    })
    const bea = await signUp(t, 'bea@example.com', invite)

    // The Convex token names the same session getSession gives.
    expect((await alex.client.query(api.members.me, {}))?.sessionId).toBe(alex.session.id)
    expect((await bea.client.query(api.members.me, {}))?.sessionId).toBe(bea.session.id)

    // This tab read Alex's session, then another tab signed in as Bea: the cookie is hers.
    const response = await endSession(t, { token: alex.session.token }, { origin: ORIGIN, cookie: bea.cookie })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ result: 'ended' })
    expect(response.headers.get('set-cookie')).toBeNull()

    expect(await alex.client.query(api.members.me, {})).toBeNull()
    expect(await bea.client.query(api.members.me, {})).toMatchObject({ sessionId: bea.session.id })
    const stillBea = (await (
      await t.fetch('/api/auth/get-session', { headers: { cookie: bea.cookie, origin: ORIGIN } })
    ).json()) as { session: { id: string } } | null
    expect(stillBea?.session.id).toBe(bea.session.id)
  })
})

describe('who is signed in', () => {
  it('is someone only while their session is there, theirs and unexpired', async () => {
    const t = setup()
    const ann = await signIn(t, 'user_ann')
    const { sessionId } = (await ann.query(api.members.me, {}))!
    expect(sessionId).toBeTruthy()
    // A token naming someone else's session, or no session at all, is no one.
    await signIn(t, 'user_bea')
    expect(await t.withIdentity({ subject: 'user_bea', sessionId }).query(api.members.me, {})).toBeNull()
    expect(await t.withIdentity({ subject: 'user_ann', sessionId: 'not-an-id' }).query(api.members.me, {})).toBeNull()
    expect(await t.withIdentity({ subject: 'user_ann' }).query(api.members.me, {})).toBeNull()
    // Nor is a token whose session has expired, though the token itself still works.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: { model: 'session', where: [{ field: '_id', value: sessionId }], update: { expiresAt: Date.now() - 1 } },
      })
    })
    expect(await ann.query(api.members.me, {})).toBeNull()
    await expect(ann.query(api.chats.counts, {})).rejects.toThrow(/signed out/)
  })
})
