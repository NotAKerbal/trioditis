import { describe, expect, it } from 'vitest'
import { api, components } from '../convex/_generated/api'
import { SETUP_TOKEN, setup, type T } from './setup'

// Adding a passkey through Better Auth's real routes, with real sign-ins, so the cookie and the
// session it carries are the ones a browser has.

const ORIGIN = 'https://trioditis.test'
// `SESSION_HEADER` in convex/auth.ts, not imported: auth.ts reads SITE_URL when it loads.
const SESSION_HEADER = 'x-trioditis-session-id'

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
  const { session } = (await (
    await t.fetch('/api/auth/get-session', { headers: { cookie, origin: ORIGIN } })
  ).json()) as { session: { id: string; userId: string } }
  return { cookie, session }
}

const options = (t: T, cookie: string, headers: Record<string, string> = {}) =>
  t.fetch('/api/auth/passkey/generate-register-options', { headers: { cookie, origin: ORIGIN, ...headers } })

const verify = (t: T, cookie: string, headers: Record<string, string> = {}) =>
  t.fetch('/api/auth/passkey/verify-registration', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: ORIGIN, ...headers },
    body: JSON.stringify({ response: {} }),
  })

async function challengeRows(t: T) {
  return await t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'verification',
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: Record<string, unknown>[] }
    return page
  })
}

async function challenges(t: T) {
  return await t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'verification',
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: unknown[] }
    return page.length
  })
}

describe('adding a passkey', () => {
  it('keeps a failed answer from clearing the sign-in, but not the challenge cookie', async () => {
    setup()
    const { withoutSessionClears } = await import('../convex/auth')
    const base = 'https://trioditis.test/api/auth'
    const request = (path: string, bound = true) =>
      new Request(`${base}${path}`, { headers: bound ? { [SESSION_HEADER]: 'session' } : {} })
    const failed = () => {
      const headers = new Headers()
      headers.append('set-cookie', 'better-auth.session_token=; Max-Age=0; Path=/')
      headers.append('set-cookie', '__Secure-better-auth.session_data=; Max-Age=0; Path=/')
      headers.append('set-cookie', 'better-auth.convex_jwt=; Max-Age=0; Path=/')
      headers.append('set-cookie', 'better-auth.dont_remember=; Max-Age=0; Path=/')
      headers.append('set-cookie', 'better-auth.passkey-challenge=abc; Path=/')
      return new Response('{}', { status: 401, headers })
    }
    for (const path of ['/passkey/generate-register-options', '/passkey/verify-registration']) {
      const kept = withoutSessionClears(request(path), failed(), base)
      expect(kept.status).toBe(401)
      expect(kept.headers.getSetCookie()).toEqual(['better-auth.passkey-challenge=abc; Path=/'])
    }
    // Unbound requests, other routes and successes are left as they are.
    expect(
      withoutSessionClears(request('/passkey/verify-registration', false), failed(), base).headers.getSetCookie(),
    ).toHaveLength(5)
    expect(withoutSessionClears(request('/sign-out'), failed(), base).headers.getSetCookie()).toHaveLength(5)
    const ok = new Response('{}', { status: 200, headers: { 'set-cookie': 'better-auth.session_token=x' } })
    expect(withoutSessionClears(request('/passkey/verify-registration'), ok, base)).toBe(ok)
  })

  it('refuses a session about to expire, setting no cookie and keeping it', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'session',
          where: [{ field: '_id', value: alex.session.id as never }],
          update: { expiresAt: Date.now() + 10_000 },
        },
      })
    })
    const response = await options(t, alex.cookie, { [SESSION_HEADER]: alex.session.id })
    expect(response.status).toBe(409)
    expect(response.headers.getSetCookie()).toEqual([])
    const kept = await t.run(
      async (ctx) =>
        await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'session',
          where: [{ field: '_id', value: alex.session.id as never }],
        }),
    )
    expect(kept).not.toBeNull()
  })

  it('gives options for the page’s own session, and without the header as before', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    const before = await challenges(t)
    expect((await options(t, alex.cookie, { [SESSION_HEADER]: alex.session.id })).status).toBe(200)
    expect((await options(t, alex.cookie)).status).toBe(200)
    // Each set of options holds a challenge.
    expect(await challenges(t)).toBe(before + 2)
  })

  it('refuses both steps, before any challenge, once another tab has signed in as someone else', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    const asAlex = t.withIdentity({ subject: alex.session.userId, sessionId: alex.session.id })
    const { token } = await asAlex.mutation(api.members.invite, { email: 'bea@example.com', role: 'member' })
    const bea = await signUp(t, 'bea@example.com', token)
    const before = await challenges(t)

    // Alex's page, with Bea's cookie now.
    for (const response of [
      await options(t, bea.cookie, { [SESSION_HEADER]: alex.session.id }),
      await verify(t, bea.cookie, { [SESSION_HEADER]: alex.session.id }),
    ]) {
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        code: 'sessionChanged',
        message: 'This page’s session has changed. Reload the page.',
      })
    }
    expect(await challenges(t)).toBe(before)
  })

  it('keeps a live challenge, sets no cookie, and leaves the other session as it was', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    const asAlex = t.withIdentity({ subject: alex.session.userId, sessionId: alex.session.id })
    const { token } = await asAlex.mutation(api.members.invite, { email: 'bea@example.com', role: 'member' })
    const bea = await signUp(t, 'bea@example.com', token)
    // Alex's page asked for options, so it holds a challenge and its cookie.
    const started = await options(t, alex.cookie, { [SESSION_HEADER]: alex.session.id })
    expect(started.status).toBe(200)
    const challengeCookie = started.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(challengeCookie).not.toBe('')
    const live = await challengeRows(t)
    expect(live).toHaveLength(1)
    // Bea's session is due for a refresh, which a refused request mustn't give it.
    const beaBefore = await t.run(async (ctx) => {
      const id = bea.session.id as never
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: 'session',
          where: [{ field: '_id', value: id }],
          // Better Auth extends a session once less than its expiry minus a day is left.
          update: { expiresAt: Date.now() + 2 * 24 * 60 * 60 * 1000 },
        },
      })
      return await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'session',
        where: [{ field: '_id', value: id }],
      })
    })

    // Then Bea signed in on another tab.
    const switched = `${bea.cookie}; ${challengeCookie}`
    const refusedOptions = await options(t, switched, { [SESSION_HEADER]: alex.session.id })
    expect(refusedOptions.status).toBe(409)
    expect(refusedOptions.headers.getSetCookie()).toEqual([])
    const refusedVerify = await verify(t, switched, { [SESSION_HEADER]: alex.session.id })
    expect(refusedVerify.status).toBe(409)
    expect(refusedVerify.headers.getSetCookie()).toEqual([])
    // Alex's challenge, the same row, untouched.
    expect(await challengeRows(t)).toEqual(live)
    const beaAfter = await t.run(
      async (ctx) =>
        await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: 'session',
          where: [{ field: '_id', value: bea.session.id as never }],
        }),
    )
    expect(beaAfter).toEqual(beaBefore)
  })

  it('refuses a bearer token alongside the cookie', async () => {
    const t = setup()
    const alex = await signUp(t, 'alex@example.com', SETUP_TOKEN)
    const response = await options(t, alex.cookie, {
      [SESSION_HEADER]: alex.session.id,
      authorization: 'Bearer someone-else',
    })
    expect(response.status).toBe(409)
    const empty = await options(t, alex.cookie, { [SESSION_HEADER]: alex.session.id, authorization: '' })
    expect(empty.status).toBe(409)
  })
})

describe('signing in with a passkey', () => {
  it('uses up its challenge, rather than failing on clearing stale ones', async () => {
    // Better Auth clears a challenge's stale copies with a query the Convex adapter only takes
    // put another way (forConvex in convex/auth.ts). Without it this answers 500, and so does
    // every passkey sign-in and registration.
    const t = setup()
    const started = await t.fetch('/api/auth/passkey/generate-authenticate-options', { headers: { origin: ORIGIN } })
    expect(started.status).toBe(200)
    const cookie = started.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    expect(await challenges(t)).toBe(1)
    const clientDataJSON = Buffer.from(JSON.stringify({ origin: ORIGIN })).toString('base64url')
    const answered = await t.fetch('/api/auth/passkey/verify-authentication', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: ORIGIN },
      body: JSON.stringify({ response: { id: 'no-such-credential', response: { clientDataJSON } } }),
    })
    // The challenge was found and used; then there's no such passkey.
    expect(answered.status).toBe(401)
    expect(await challenges(t)).toBe(0)
  })
})

describe('the adapter for Convex', () => {
  it('deletes exactly the stale copies of a challenge, as Better Auth asks', async () => {
    setup()
    const { forConvex } = await import('../convex/auth')
    const rows = [
      { id: 'a', identifier: 'x', createdAt: new Date(1000) },
      { id: 'b', identifier: 'x', createdAt: new Date(2000) },
      { id: 'c', identifier: 'x', createdAt: new Date(3000) },
      { id: 'd', identifier: 'y', createdAt: new Date(1000) },
    ]
    type W = { field: string; operator?: string; value: unknown }
    const matches = (row: Record<string, unknown>, w: W) =>
      w.operator === 'not_in' ? !(w.value as unknown[]).includes(row[w.field]) : row[w.field] === w.value
    const calls: unknown[] = []
    const fake = {
      findMany: async ({ where }: { where: W[] }) => {
        calls.push(['findMany', where])
        return rows.filter((row) => where.every((w) => matches(row, w)))
      },
      delete: async ({ where }: { where: W[] }) => {
        rows.splice(
          rows.findIndex((row) => row.id === where[0]!.value),
          1,
        )
      },
      deleteMany: async () => {
        throw new Error('not reached for this query')
      },
    }
    const adapter = forConvex((() => fake) as never)({} as never) as unknown as {
      deleteMany: (args: { model: string; where: W[] }) => Promise<number>
    }
    // `b` is in use; `a` is older, `c` newer, and `d` another challenge.
    const deleted = await adapter.deleteMany({
      model: 'verification',
      where: [
        { field: 'identifier', value: 'x' },
        { field: 'id', operator: 'ne', value: 'b' },
        { field: 'createdAt', operator: 'lte', value: new Date(2000) },
      ],
    })
    expect(deleted).toBe(1)
    expect(rows.map((row) => row.id)).toEqual(['b', 'c', 'd'])
    // `ne` on the ID went to the adapter as `not_in`, which it takes.
    expect(calls).toEqual([
      [
        'findMany',
        [
          { field: 'identifier', value: 'x' },
          { field: 'id', operator: 'not_in', value: ['b'] },
        ],
      ],
    ])
  })
})
