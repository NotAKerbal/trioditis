import { createAuthClient } from 'better-auth/client'
import { describe, expect, it } from 'vitest'
import { askThrough, confirmSession, type SessionStore } from '../src/features/auth/gate-load.ts'

/** A Better Auth client whose server answers /get-session from `answers`, in order, in memory. */
function clientAnswering(answers: (() => Response)[]) {
  let asked = 0
  const client = createAuthClient({
    baseURL: 'https://trioditis.test',
    fetchOptions: {
      customFetchImpl: async () => {
        asked++
        return (answers.shift() ?? (() => new Response('null', { status: 200 })))()
      },
    },
  })
  return { client, asked: () => asked }
}

const unavailable = () => new Response('Service Unavailable', { status: 503 })
const signedIn = () =>
  Response.json({
    session: { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    user: { id: 'u1', email: 'sam@x.test' },
  })

describe('confirming the session after the server was briefly down', () => {
  it('fills the store the Convex provider reads, without a reload, once an answer comes', async () => {
    const { client, asked } = clientAnswering([unavailable, unavailable, signedIn])
    const store = client.$store.atoms.session as unknown as SessionStore
    const waits: number[] = []
    const answer = await confirmSession(
      askThrough(store),
      async (ms) => void waits.push(ms),
      () => false,
    )
    expect(answer).toBe('signedIn')
    expect(asked()).toBe(3)
    expect(waits).toEqual([2_000, 4_000])
    // What authClient.useSession() gives the provider now: the session, and no error.
    expect(store.get()).toMatchObject({ data: { session: { id: 's1' } }, error: null })
  })

  it('settles on signed out when the server answers there is no session', async () => {
    const { client } = clientAnswering([unavailable, () => Response.json(null)])
    const store = client.$store.atoms.session as unknown as SessionStore
    expect(
      await confirmSession(
        askThrough(store),
        async () => undefined,
        () => false,
      ),
    ).toBe('signedOut')
    expect(store.get().data).toBeNull()
  })
})
