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
})
