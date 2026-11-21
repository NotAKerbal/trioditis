import { afterEach, describe, expect, it, vi } from 'vitest'
import { components } from '../convex/_generated/api'
import * as account from '../convex/account'
import { SETUP_TOKEN, setup, type T } from './setup'

// convex/auth.ts reads its address as it loads, and account.ts imports it before setup() runs.
vi.hoisted(() => {
  process.env.SITE_URL = 'https://trioditis.test'
})

const ORIGIN = 'https://trioditis.test'
const PASSWORD = 'a-long-test-password'

const post = (t: T, path: string, body: unknown, headers: Record<string, string> = {}) =>
  t.fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  })

const sessions = (t: T) =>
  t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'session',
      paginationOpts: { cursor: null, numItems: 50 },
    })) as { page: unknown[] }
    return page.length
  })

type Handler = { _handler: (...args: unknown[]) => Promise<number> }
const noted = account.credentialVersionFor as unknown as Handler
const original = noted._handler

afterEach(() => {
  noted._handler = original
})

describe('a password sign-in through Better Auth', () => {
  it('keeps its session while the password stays the same, and ends it if the password moved mid sign-in', async () => {
    const t = setup()
    const signUp = await post(
      t,
      'sign-up/email',
      { email: 'sam@example.com', password: PASSWORD, name: 'Sam' },
      { 'x-trioditis-invite': SETUP_TOKEN },
    )
    expect(signUp.status).toBe(200)
    const before = await sessions(t)
    expect((await post(t, 'sign-in/email', { email: 'sam@example.com', password: PASSWORD })).status).toBe(200)
    expect(await sessions(t)).toBe(before + 1)

    // As if a reset committed after the sign-in noted the version and checked the old password.
    noted._handler = async () => -1
    const raced = await post(t, 'sign-in/email', { email: 'sam@example.com', password: PASSWORD })
    expect(raced.status).toBe(401)
    expect(
      raced.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith('better-auth.session_token=') && !cookie.includes('Max-Age=0')),
    ).toBe(false)
    expect(await sessions(t)).toBe(before + 1)
  })
})
