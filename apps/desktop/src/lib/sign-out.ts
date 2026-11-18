import { authClient } from './auth-client.ts'
import { forgetIdentity, sessionLivesOn } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/** What to say when the server didn't confirm the session ended. */
export const SIGN_OUT_FAILED = 'You’re still signed in: the server couldn’t be reached to sign you out. Try again.'

/** How long a call to the auth server may take before it's given up on. */
export const AUTH_WAIT_MS = 10_000

/**
 * The session this tab is signed in to as `userId`, asked of the server, not a cache; null if
 * none. Throws if the server can't be reached or doesn't answer within AUTH_WAIT_MS.
 */
export async function currentSession(userId: string): Promise<string | null> {
  const { data, error } = await authClient.getSession({
    query: { disableCookieCache: true },
    fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) },
  })
  if (error) throw new Error(error.message ?? 'the server couldn’t say who’s signed in')
  return data?.user.id === userId ? data.session.id : null
}

/**
 * Asks the server to end the session: 'ended', 'kept' when it answered no (the session lives
 * on), or 'unknown' when it didn't answer in time or failed on its side, either of which may
 * have ended the session all the same.
 */
async function endSession(): Promise<'ended' | 'kept' | 'unknown'> {
  try {
    const result = await authClient.signOut({ fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) } })
    if (!result?.error) return 'ended'
    return result.error.status && result.error.status < 500 ? 'kept' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Signs out. With `userId`, it first forgets this device's copy of their key (or only key
 * `onlyKid`; with null, none, though saves under way anywhere are still stopped), noting the
 * session it's ending so no tab keeps a key for it from then on (lib/keys.ts), then ends the
 * session. Only once the server confirms the session ended does it go to the sign-in page, which
 * says if the key's removal couldn't be confirmed. Otherwise it returns false, for the caller to
 * say so and offer a retry: the person is still signed in, as far as anyone can tell. If the
 * server says so for sure, saves for the session may go ahead again; if it can't say, they stay
 * stopped until signing out goes through.
 */
export async function signOut(userId?: string, { onlyKid }: { onlyKid?: string | null } = {}) {
  let unconfirmed = false
  let session: string | null = null
  if (userId) {
    try {
      session = await currentSession(userId)
    } catch {
      // Nothing is changed when the server can't be reached: signing out couldn't go through.
      return false
    }
    try {
      await forgetIdentity(userId, { onlyKid, endingSession: session ?? undefined })
    } catch {
      unconfirmed = true
    }
  }
  const outcome = await endSession()
  // Signed out already (no session to end): the sign-in page is where this tab belongs.
  if (outcome !== 'ended' && !(userId && session === null)) {
    if (outcome === 'kept' && userId && session) await sessionLivesOn(userId, session).catch(() => undefined)
    return false
  }
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return true
}
