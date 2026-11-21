import { createAuthClient } from 'better-auth/client'
import { describe, expect, it } from 'vitest'
import {
  askThrough,
  confirmSession,
  reauthDelay,
  sessionAnswer,
  wakeableSleep,
  type SessionStore,
} from '../src/features/auth/gate-load.ts'

// The UAT failure: the app opened from this device while the server was away; once it came back,
// the page said "You're signed out" though a reload showed the session was fine. These drive the
// gate's sign-in check through the same steps, with the server's answers in memory.

describe('a cold start offline, then the server comes back', () => {
  it('signs in as soon as the server answers, without a reload, and never says signed out', async () => {
    let serverUp = false
    let asked = 0
    const client = createAuthClient({
      baseURL: 'https://trioditis.test',
      fetchOptions: {
        customFetchImpl: async () => {
          asked++
          // Offline: fetch rejects. Back: a proxy's 503 once, then the session.
          if (!serverUp) throw new TypeError('Failed to fetch')
          if (asked === 3) return new Response('Service Unavailable', { status: 503 })
          return Response.json({
            session: { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 60_000).toISOString() },
            user: { id: 'u1', email: 'sam@x.test' },
          })
        },
      },
    })
    const store = client.$store.atoms.session as unknown as SessionStore
    // Stands in for Convex's connection state and the browser's `online` event.
    const wakes = new Set<() => void>()
    const reconnect = () => [...wakes].forEach((wake) => wake())
    const sleep = wakeableSleep((wake) => {
      wakes.add(wake)
      return () => wakes.delete(wake)
    })
    const started = Date.now()
    const answer = confirmSession(askThrough(store), sleep, () => false)
    // Two failed tries while offline, then the server is back and Convex reconnects.
    await new Promise((resolve) => setTimeout(resolve, 20))
    reconnect()
    await new Promise((resolve) => setTimeout(resolve, 20))
    serverUp = true
    reconnect()
    await new Promise((resolve) => setTimeout(resolve, 20))
    reconnect()
    expect(await answer).toBe('signedIn')
    // Woken by the reconnects, not by the 2s, 4s, 8s timers.
    expect(Date.now() - started).toBeLessThan(1_000)
    // What the Convex provider reads (authClient.useSession()): the session, no error.
    expect(store.get()).toMatchObject({ data: { session: { id: 's1' } }, error: null })
  })

  it('takes a fetch cut short, with nothing in the store yet, for no answer rather than signed out', async () => {
    const store: SessionStore = {
      get: () => ({ data: null, error: null, isPending: true, isRefetching: true, refetch: async () => undefined }),
    }
    expect(sessionAnswer(await askThrough(store)())).toBe('unknown')
  })

  it('counts signed out only from an answer with no session', async () => {
    const client = createAuthClient({
      baseURL: 'https://trioditis.test',
      fetchOptions: { customFetchImpl: async () => Response.json(null) },
    })
    const store = client.$store.atoms.session as unknown as SessionStore
    expect(sessionAnswer(await askThrough(store)())).toBe('signedOut')
  })

  it('starts the Convex provider afresh after a grace period, later each time', () => {
    expect([0, 1, 2, 10].map(reauthDelay)).toEqual([5_000, 7_000, 11_000, 33_000])
  })
})
