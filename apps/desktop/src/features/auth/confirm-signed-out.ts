import { useEffect, useRef, useState } from 'react'
import { askThrough, confirmSession, reauthDelay, wakeableSleep, type SessionStore } from './gate-load.ts'

export interface ConfirmOptions {
  /** `useConvexAuth()`'s answer. */
  isLoading: boolean
  isAuthenticated: boolean
  /** Better Auth's session store, the one the Convex provider reads. */
  store: SessionStore
  /** Calls `wake` when the server may answer now (online again, Convex reconnected). */
  wakes: (wake: () => void) => () => void
  /** Starts the Convex provider afresh (lib/auth-epoch.ts), and how many times it has been. */
  restartAuth: () => void
  restarts: () => number
}

/**
 * Whether the browser is really signed out, as Better Auth says, before the page is sent to sign
 * in: right after signing in or up Convex can report "not signed in" for a moment, and while the
 * server is away it can't say anything. Only a completed answer of no session counts.
 *
 * One check runs for each time Convex reports signed out, and it keeps running through the
 * loading the check itself causes (asking the store again makes the provider load): it ends only
 * when it has an answer, Convex signs in, or the page goes. While the server can't be reached it
 * asks again, backing off, and sooner once it may be back (`wakes`).
 *
 * If Better Auth says signed in but Convex still isn't, its token was asked for while the server
 * was away; unless Convex signs in meanwhile, the provider is started afresh after a grace period.
 */
export function useConfirmedSignedOut({
  isLoading,
  isAuthenticated,
  store,
  wakes,
  restartAuth,
  restarts,
}: ConfirmOptions): boolean {
  const [signedOut, setSignedOut] = useState(false)
  const running = useRef<{ cancel: () => void } | null>(null)
  const restart = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const authenticated = useRef(isAuthenticated)
  authenticated.current = isAuthenticated
  const needed = !isLoading && !isAuthenticated

  // Signed in to Convex: nothing to confirm any more.
  useEffect(() => {
    if (!isAuthenticated) return
    running.current?.cancel()
    running.current = null
    clearTimeout(restart.current)
    setSignedOut(false)
  }, [isAuthenticated])

  useEffect(() => {
    if (!needed || running.current || signedOut) return
    let cancelled = false
    const check = { cancel: () => (cancelled = true) }
    running.current = check
    void confirmSession(askThrough(store), wakeableSleep(wakes), () => cancelled).then((answer) => {
      if (running.current === check) running.current = null
      if (cancelled || authenticated.current) return
      if (answer === 'signedOut') setSignedOut(true)
      if (answer === 'signedIn') {
        clearTimeout(restart.current)
        restart.current = setTimeout(() => {
          if (!authenticated.current) restartAuth()
        }, reauthDelay(restarts()))
      }
    })
    // Not cancelled here: `needed` turning false is most often this very check's refetch.
  }, [needed, signedOut, store, wakes, restartAuth, restarts])

  // Gone: whatever is under way stops.
  useEffect(
    () => () => {
      running.current?.cancel()
      running.current = null
      clearTimeout(restart.current)
    },
    [],
  )
  return signedOut
}
