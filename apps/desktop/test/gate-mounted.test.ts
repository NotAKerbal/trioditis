// @vitest-environment happy-dom
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { createAuthClient } from 'better-auth/react'
import { useConvexAuth } from 'convex/react'
import { StrictMode, act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { useConfirmedSignedOut } from '../src/features/auth/confirm-signed-out.ts'
import type { SessionStore } from '../src/features/auth/gate-load.ts'

// The gate's sign-in check mounted with the real Better Auth store and the real Convex provider
// (`ConvexBetterAuthProvider`), against a server answering from memory. The Convex client stands
// in for the backend's side of auth: a token from the provider means signed in.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const session = {
  session: { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  user: { id: 'u1', email: 'sam@x.test' },
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A server whose /get-session answers come from `answers` in order (then the last), each after `delay`. */
function server(answers: (() => Response)[], delay = 15) {
  let gets = 0
  const fetchImpl = async (input: RequestInfo | URL) => {
    await wait(delay)
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/convex/token')) return Response.json({ token: 'header.eyJzZXNzaW9uSWQiOiJzMSJ9.sig' })
    gets++
    return (answers[Math.min(gets - 1, answers.length - 1)] ?? answers.at(-1)!)()
  }
  return { fetchImpl, gets: () => gets }
}

function mount(answers: (() => Response)[]) {
  const backend = server(answers)
  const authClient = createAuthClient({
    baseURL: 'https://trioditis.test',
    plugins: [convexClient()],
    fetchOptions: { customFetchImpl: backend.fetchImpl },
  })
  const convex = {
    setAuth: (
      fetchToken: (args: { forceRefreshToken: boolean }) => Promise<string | null>,
      onChange: (ok: boolean) => void,
    ) => void fetchToken({ forceRefreshToken: false }).then((token) => onChange(!!token)),
    clearAuth: () => undefined,
  }
  const restarts = { count: 0 }
  function Gate() {
    const { isLoading, isAuthenticated } = useConvexAuth()
    const signedOut = useConfirmedSignedOut({
      isLoading,
      isAuthenticated,
      store: authClient.$store.atoms.session as unknown as SessionStore,
      wakes: () => () => undefined,
      restartAuth: () => restarts.count++,
      restarts: () => restarts.count,
    })
    return createElement('p', null, isAuthenticated ? 'inbox' : signedOut ? 'sign-in' : 'waiting')
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() =>
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(ConvexBetterAuthProvider, {
          client: convex as never,
          authClient: authClient as never,
          children: createElement(Gate),
        }),
      ),
    ),
  )
  return { container, root, backend, restarts }
}

let mounted: ReturnType<typeof mount> | null = null
afterEach(() => {
  act(() => mounted?.root.unmount())
  mounted = null
})

async function until(check: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!check() && Date.now() < end) await act(() => wait(10))
  return check()
}

describe('the gate, mounted with the Convex provider', () => {
  it('reaches sign-in for a browser with no session, though the server answers slowly', async () => {
    mounted = mount([() => Response.json(null)])
    const text = () => mounted!.container.textContent
    expect(await until(() => text() === 'sign-in', 3_000)).toBe(true)
    // The check's own refetch made the provider load; it ran on, rather than starting over and over.
    expect(mounted.backend.gets()).toBeLessThanOrEqual(3)
  })

  it('reaches the inbox once the server, unavailable at first, answers with the session', async () => {
    mounted = mount([
      () => new Response('Service Unavailable', { status: 503 }),
      () => new Response('Service Unavailable', { status: 503 }),
      () => Response.json(session),
    ])
    const text = () => mounted!.container.textContent
    // Backoff waits 2s then 4s before the third ask.
    expect(await until(() => text() === 'inbox', 9_000)).toBe(true)
    expect(text()).not.toBe('sign-in')
  }, 15_000)
})
