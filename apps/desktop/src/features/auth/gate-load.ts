/**
 * What the key gate shows before it can decide between setup, unlock and the app:
 *
 * - `wait`: the splash, while this device's own storage is read (quick, local) or the server is
 *   still being asked and nothing here can stand in for its answer.
 * - `decide`: the server has said what the account's key state is.
 * - `openLocal`: the server hasn't answered (still connecting, offline, or failed), but this device
 *   already keeps the person's key. An account's identity key never changes once set (keys.setup
 *   refuses another), and a key is kept here only once its backups exist, so the app can open with
 *   it rather than wait. Not while a recovery key shown before a reload is still to be checked: that
 *   check needs the server.
 * - `failed`: the server's answer failed and there's no key here to go on with: say so, with retry.
 */
export type KeyGateLoad = 'wait' | 'decide' | 'openLocal' | 'failed'

export function keyGateLoad(state: {
  /** The save token: null until it has been read from this device's storage. */
  token: number | 'failed' | null
  remote: { failed: boolean; hasData: boolean }
  local: { pending: boolean; hasKey: boolean }
  /** A recovery key shown before a reload still waits to be checked against the server. */
  recoveryCheckPending: boolean
}): KeyGateLoad {
  if (state.token === null || state.local.pending) return 'wait'
  if (state.remote.hasData) return 'decide'
  if (state.local.hasKey && !state.recoveryCheckPending) return 'openLocal'
  return state.remote.failed ? 'failed' : 'wait'
}

/** What asking Better Auth for the session said: only an answer settles it, never a failure. */
export function sessionAnswer(result: { data: unknown; error: unknown } | null): 'signedIn' | 'signedOut' | 'unknown' {
  if (!result || result.error) return 'unknown'
  return result.data ? 'signedIn' : 'signedOut'
}

/** The wait before asking again after the `attempt`th unknown answer: 2s, doubling, at most 30s. */
export function retryDelay(attempt: number): number {
  return Math.min(2_000 * 2 ** attempt, 30_000)
}

/** Better Auth's session store, the one `authClient.useSession()` and the Convex provider read. */
export interface SessionStore {
  get(): {
    data: unknown
    error: unknown
    isPending?: boolean
    isRefetching?: boolean
    refetch: () => Promise<void>
  }
}

/** Not an answer: the store's fetch was cut short (another took its place) and is still under way. */
const STILL_ASKING = { status: 'pending' }

/**
 * Asks for the session through the provider's own store (`authClient.$store.atoms.session`), not a
 * side request: so an answer that comes after failures reaches the Convex provider too, which then
 * fetches its token and signs the page in without a reload. A store still fetching (its `data` is
 * null meanwhile) or holding an error is no answer.
 */
export function askThrough(store: SessionStore) {
  return async () => {
    await store.get().refetch()
    const { data, error, isPending, isRefetching } = store.get()
    return { data, error: error ?? (isPending || isRefetching ? STILL_ASKING : null) }
  }
}

/**
 * A wait that ends early when `subscribe`'s wake fires (the browser coming online, Convex's
 * connection coming back), so the session is asked about as soon as the server can answer, not
 * up to 30s later.
 */
export function wakeableSleep(subscribe: (wake: () => void) => () => void) {
  return (ms: number) =>
    new Promise<void>((resolve) => {
      let unsubscribe = () => {}
      const done = () => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(done, ms)
      unsubscribe = subscribe(done)
    })
}

/**
 * How long to wait, once Better Auth says the browser is signed in but Convex still isn't, before
 * starting the provider afresh (`attempt` times so far): its token was asked for while the server
 * was away and came back empty, and it won't ask again for the same session. Longer each time.
 */
export function reauthDelay(attempt: number): number {
  return 3_000 + retryDelay(attempt)
}

/**
 * Asks whether the browser is signed out until it gets an answer: a request that fails (offline,
 * the server down) is asked again after `retryDelay`, until `cancelled`. Answers what it learned,
 * or null if it was cancelled first.
 */
export async function confirmSession(
  ask: () => Promise<{ data: unknown; error: unknown }>,
  sleep: (ms: number) => Promise<void>,
  cancelled: () => boolean,
): Promise<'signedIn' | 'signedOut' | null> {
  for (let attempt = 0; !cancelled(); attempt++) {
    const answer = sessionAnswer(await ask().catch(() => null))
    if (cancelled()) return null
    if (answer !== 'unknown') return answer
    await sleep(retryDelay(attempt))
  }
  return null
}

/** How long the splash waits on the server before it also says it's still trying. */
export const SLOW_SERVER_MS = 15_000
