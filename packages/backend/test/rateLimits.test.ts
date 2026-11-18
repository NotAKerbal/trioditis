import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../convex/_generated/api'
import { SETUP_TOKEN, setup, type T } from './setup'

// Through Better Auth's real routes, so the rules, the store and the 429 are the ones a
// deployment answers with.

const ORIGIN = 'https://trioditis.test'
// `CLIENT_IP_HEADER` in convex/auth.ts, not imported: auth.ts reads SITE_URL when it loads,
// which must be after `setup` sets it.
const CLIENT_IP_HEADER = 'x-trioditis-client-ip'
const PASSWORD = 'a-long-test-password'

function post(t: T, path: string, body: unknown, ip?: string, headers: Record<string, string> = {}) {
  return t.fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(ip ? { [CLIENT_IP_HEADER]: ip } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const signIn = (t: T, email: string, ip?: string, password = 'a-wrong-password') =>
  post(t, 'sign-in/email', { email, password }, ip)

/**
 * A sign-in with no password. Both limits count it before Better Auth turns the body down
 * (400), and it skips the password hashing, so loops of them stay quick.
 */
const attempt = (t: T, email: string, ip?: string) => post(t, 'sign-in/email', { email }, ip)

/** The first admin, signed up from an address of its own so the tests' addresses start full. */
async function admin(t: T) {
  const response = await post(
    t,
    'sign-up/email',
    { email: 'sam@example.com', password: PASSWORD, name: 'Sam' },
    '192.0.2.250',
    {
      'x-trioditis-invite': SETUP_TOKEN,
    },
  )
  expect(response.status).toBe(200)
}

/**
 * Moves the clock on. While Date stands still, convex-test still moves each transaction a
 * millisecond past the last commit, so a wait meant to cover a Retry-After adds a second.
 */
function advance(seconds: number) {
  vi.setSystemTime(Date.now() + seconds * 1000)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('per address', () => {
  it('refuses the 11th sign-in in a minute from one address, then lets more through as it refills', async () => {
    const t = setup()
    await admin(t)
    for (let i = 0; i < 10; i++) expect((await signIn(t, `guess${i}@example.com`, '203.0.113.1')).status).toBe(401)

    // Even with the right password: the limit doesn't depend on what is guessed.
    const refused = await signIn(t, 'sam@example.com', '203.0.113.1', PASSWORD)
    expect(refused.status).toBe(429)
    // Ten a minute is one every six seconds.
    expect(refused.headers.get('retry-after')).toBe('6')
    expect(await refused.json()).toEqual({ message: 'Too many requests. Please try again later.' })

    advance(6 + 1)
    expect((await signIn(t, 'sam@example.com', '203.0.113.1', PASSWORD)).status).toBe(200)
    expect((await signIn(t, 'sam@example.com', '203.0.113.1', PASSWORD)).status).toBe(429)

    // A client that stops is let in fully again after a minute, with no lockout to sit out.
    advance(60)
    for (let i = 0; i < 10; i++) expect((await signIn(t, `guess${i}@example.com`, '203.0.113.1')).status).toBe(401)
    expect((await signIn(t, 'guess@example.com', '203.0.113.1')).status).toBe(429)
  })

  it('leaves other addresses alone', async () => {
    const t = setup()
    await admin(t)
    for (let i = 0; i < 10; i++) await signIn(t, `guess${i}@example.com`, '203.0.113.1')
    expect((await signIn(t, 'guess@example.com', '203.0.113.1')).status).toBe(429)
    expect((await signIn(t, 'sam@example.com', '203.0.113.2', PASSWORD)).status).toBe(200)
    // IPv6 addresses count by their /64.
    for (let i = 0; i < 10; i++) await signIn(t, `guess${i}@example.com`, `2001:db8:1:1::${i + 1}`)
    expect((await signIn(t, 'guess@example.com', '2001:db8:1:1::ff')).status).toBe(429)
    expect((await signIn(t, 'guess@example.com', '2001:db8:1:2::1')).status).toBe(401)
  })

  it('reads the address only from the proxy’s header', async () => {
    const t = setup()
    for (let i = 0; i < 10; i++) {
      await post(t, 'sign-in/email', { email: `guess${i}@example.com`, password: 'x' }, '203.0.113.1', {
        'x-forwarded-for': `198.51.100.${i}`,
      })
    }
    const refused = await post(t, 'sign-in/email', { email: 'guess@example.com', password: 'x' }, '203.0.113.1', {
      'x-forwarded-for': '198.51.100.99',
    })
    expect(refused.status).toBe(429)
  })

  it('counts sign-up, which redeems invitations and the setup token, as strictly', async () => {
    const t = setup()
    for (let i = 0; i < 10; i++) {
      const response = await post(
        t,
        'sign-up/email',
        { email: `new${i}@example.com`, password: PASSWORD, name: 'x' },
        '203.0.113.1',
        {
          'x-trioditis-invite': `guess-${i}`,
        },
      )
      expect(response.status).toBe(403)
    }
    const refused = await post(
      t,
      'sign-up/email',
      { email: 'new@example.com', password: PASSWORD, name: 'x' },
      '203.0.113.1',
      {
        'x-trioditis-invite': SETUP_TOKEN,
      },
    )
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('6')
  })

  it('limits end-session', async () => {
    const t = setup()
    for (let i = 0; i < 10; i++) {
      const response = await post(t, 'end-session', { token: `guess-${i}` }, '203.0.113.1')
      expect(await response.json()).toEqual({ result: 'absent' })
    }
    const refused = await post(t, 'end-session', { token: 'guess' }, '203.0.113.1')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('6')
    expect(refused.headers.get('set-cookie')).toBeNull()
  })

  it('gives other auth routes a loose limit', async () => {
    const t = setup()
    for (let i = 0; i < 300; i++) {
      const response = await t.fetch('/api/auth/get-session', {
        headers: { origin: ORIGIN, [CLIENT_IP_HEADER]: '203.0.113.1' },
      })
      expect(response.status).toBe(200)
    }
    const refused = await t.fetch('/api/auth/get-session', {
      headers: { origin: ORIGIN, [CLIENT_IP_HEADER]: '203.0.113.1' },
    })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toBe('1')
  })

  it('isn’t applied without the proxy’s header, rather than give everyone one bucket', async () => {
    const t = setup()
    await admin(t)
    for (let i = 0; i < 20; i++) {
      const response = await post(t, 'sign-in/email', { email: `guess${i}@example.com` }, undefined, {
        'x-forwarded-for': '198.51.100.1',
      })
      expect(response.status).toBe(400)
    }
    expect((await signIn(t, 'sam@example.com', undefined, PASSWORD)).status).toBe(200)
  })
})

describe('per account', () => {
  it('refuses an account only well above one address’s rate, across several', async () => {
    const t = setup()
    await admin(t)
    // Three addresses at their limit: thirty attempts, all let through.
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      for (let i = 0; i < 10; i++) expect((await attempt(t, 'sam@example.com', ip)).status).toBe(400)
    }
    // A fourth finds the account's bucket empty, however the email is written.
    const refused = await signIn(t, ' Sam@Example.COM', '203.0.113.4')
    expect(refused.status).toBe(429)
    // Thirty a minute is one every two seconds.
    expect(refused.headers.get('retry-after')).toBe('2')
    expect(refused.headers.get('x-retry-after')).toBe('2')
    // Only that account.
    expect((await signIn(t, 'other@example.com', '203.0.113.4')).status).toBe(401)
    advance(2 + 1)
    expect((await signIn(t, 'sam@example.com', '203.0.113.4', PASSWORD)).status).toBe(200)
  })

  it('can’t be emptied from one address', async () => {
    const t = setup()
    await admin(t)
    for (let i = 0; i < 10; i++) expect((await attempt(t, 'sam@example.com', '203.0.113.1')).status).toBe(400)
    // From here the address gets at most one guess every six seconds, slower than the account
    // refills.
    for (let i = 0; i < 30; i++) {
      advance(6 + 1)
      expect((await attempt(t, 'sam@example.com', '203.0.113.1')).status).toBe(400)
    }
    expect((await signIn(t, 'sam@example.com', '203.0.113.2', PASSWORD)).status).toBe(200)
  })

  it('applies without the proxy’s header too', async () => {
    const t = setup()
    await admin(t)
    for (let i = 0; i < 30; i++) expect((await attempt(t, 'sam@example.com')).status).toBe(400)
    expect((await signIn(t, 'sam@example.com', undefined, PASSWORD)).status).toBe(429)
  })
})

describe('what is counted', () => {
  it('refuses email sign-in and sign-up sent as forms, which the per-account limit can’t read', async () => {
    const t = setup()
    await admin(t)
    for (const path of ['sign-in/email', 'sign-up/email']) {
      const form = await t.fetch(`/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
        body: new URLSearchParams({ email: 'sam@example.com', password: PASSWORD, name: 'Sam' }).toString(),
      })
      expect(form.status).toBe(415)
      const multipart = new FormData()
      multipart.set('email', 'sam@example.com')
      multipart.set('password', PASSWORD)
      const parts = await t.fetch(`/api/auth/${path}`, { method: 'POST', headers: { origin: ORIGIN }, body: multipart })
      expect(parts.status).toBe(415)
    }
  })

  it('turns off Better Auth’s password check for a signed-in session', async () => {
    const t = setup()
    const response = await post(t, 'verify-password', { password: PASSWORD }, '203.0.113.1')
    expect(response.status).toBe(404)
  })

  it('keeps no bucket for a path that isn’t an auth route', async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) expect((await post(t, `made-up-${i}`, {}, '203.0.113.1')).status).toBe(404)
    expect(await t.run(async (ctx) => await ctx.db.query('rateLimits').collect())).toEqual([])
  })
})

describe('Retry-After', () => {
  it('is the shortest wait that will be let through, even partway through a refill', async () => {
    const t = setup()
    const consume = () => t.mutation(internal.rateLimits.consume, { key: 'k', max: 10, window: 60 })
    for (let i = 0; i < 10; i++) expect((await consume()).allowed).toBe(true)
    // Eight seconds in, a third of a token is left over after this one.
    advance(8)
    expect((await consume()).allowed).toBe(true)
    const refused = await consume()
    expect(refused).toEqual({ allowed: false, retryAfter: 4 })
    advance(4)
    expect((await consume()).allowed).toBe(true)
  })
})

describe('the store', () => {
  it('keeps the count in Convex, hashed, from one request to the next', async () => {
    const t = setup()
    for (let i = 0; i < 10; i++) await signIn(t, `guess${i}@example.com`, '203.0.113.1')
    expect((await signIn(t, 'guess@example.com', '203.0.113.1')).status).toBe(429)

    const rows = await t.run(async (ctx) => await ctx.db.query('rateLimits').collect())
    // The address's bucket and one per email guessed, keyed by hash only.
    expect(rows).toHaveLength(11)
    for (const row of rows) {
      expect(row.key).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(row)).not.toMatch(/203\.0\.113|example\.com/)
    }

    // The limit is what the table holds, not anything kept in memory between requests.
    await t.run(async (ctx) => {
      for (const row of rows) await ctx.db.delete(row._id)
    })
    expect((await signIn(t, 'guess@example.com', '203.0.113.1')).status).toBe(401)
  })

  it('lets no more through than the bucket holds when requests arrive together', async () => {
    const t = setup()
    const responses = await Promise.all(
      Array.from({ length: 25 }, (_, i) => signIn(t, `guess${i}@example.com`, '203.0.113.1')),
    )
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10)
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15)

    const results = await Promise.all(
      Array.from({ length: 25 }, () => t.mutation(internal.rateLimits.consume, { key: 'k', max: 10, window: 60 })),
    )
    expect(results.filter((result) => result.allowed)).toHaveLength(10)
  })

  it('prunes buckets once they have refilled', async () => {
    const t = setup()
    // One request leaves an address's bucket six seconds from full, and an account's two.
    await signIn(t, 'guess@example.com', '203.0.113.1')
    advance(4)
    await signIn(t, 'other@example.com', '203.0.113.2')
    advance(3)
    await t.mutation(internal.rateLimits.prune, {})
    // Only the second address's bucket is still filling.
    expect(await t.run(async (ctx) => (await ctx.db.query('rateLimits').collect()).length)).toBe(1)
    advance(4)
    await t.mutation(internal.rateLimits.prune, {})
    expect(await t.run(async (ctx) => await ctx.db.query('rateLimits').collect())).toEqual([])
  })
})
