import { useSyncExternalStore } from 'react'

/*
 * Starts the Convex auth provider afresh (main.tsx keys it by this) when Better Auth says the
 * browser is signed in but Convex isn't: the provider asks for a Convex token once per session,
 * and one asked for while the server was away came back empty, so without this the page stayed
 * signed out of Convex until a reload. See useConfirmedSignedOut in features/auth/app-gate.tsx.
 */

let epoch = 0
const listeners = new Set<() => void>()

export function restartAuth() {
  epoch++
  for (const listener of listeners) listener()
}

/** How many times the provider has been started afresh on this page. */
export const authRestarts = () => epoch

export function useAuthEpoch(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    () => epoch,
  )
}
