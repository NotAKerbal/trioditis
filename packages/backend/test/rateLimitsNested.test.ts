import { expect, it } from 'vitest'
import { setup } from './setup'

// A SITE_URL with a path, set before auth.ts first loads (it reads SITE_URL then), in a file of
// its own so no other test has loaded it already. The limits must follow the base Better Auth
// itself routes under.

const ORIGIN = 'https://trioditis.test'
const CLIENT_IP_HEADER = 'x-trioditis-client-ip'

it('counts requests under the base a SITE_URL with a path gives', async () => {
  const t = setup()
  process.env.SITE_URL = 'https://trioditis.test/api/auth/nested/'
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    t.fetch(`/api/auth/nested/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, [CLIENT_IP_HEADER]: '203.0.113.1', ...headers },
      body: JSON.stringify(body),
    })
  const session = await t.fetch('/api/auth/nested/get-session', {
    headers: { origin: ORIGIN, [CLIENT_IP_HEADER]: '203.0.113.9' },
  })
  expect(session.status).toBe(200)
  expect(await t.run(async (ctx) => (await ctx.db.query('rateLimits').collect()).length)).toBe(1)
  // The 11th sign-in from one address is refused.
  for (let i = 0; i < 10; i++) expect((await post('sign-in/email', { email: `g${i}@example.com` })).status).toBe(400)
  expect((await post('sign-in/email', { email: 'g@example.com' })).status).toBe(429)
})
