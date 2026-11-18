import { authClient } from './auth-client.ts'
import { forgetIdentity } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/** What to say when the server didn't confirm the session ended. */
export const SIGN_OUT_FAILED =
  'Signing out didn’t go through, or the server couldn’t confirm it. You may still be signed in here. Try again.'

/** How long a call to the auth server may take before it's given up on. */
export const AUTH_WAIT_MS = 10_000

/**
 * The session this tab is signed in to as `userId`, asked of the server, not a cache; null if
 * none. Throws if the server can't be reached or doesn't answer within AUTH_WAIT_MS.
 */
export async function currentSession(userId: string): Promise<{ id: string; token: string } | null> {
  const { data, error } = await authClient.getSession({
    query: { disableCookieCache: true },
    fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) },
  })
  if (error) throw new Error(error.message ?? 'the server couldn’t say who’s signed in')
  return data?.user.id === userId ? { id: data.session.id, token: data.session.token } : null
}

/** The ID of the session this tab is signed in to as `userId` (see currentSession). */
export const currentSessionId = (userId: string) => currentSession(userId).then((session) => session?.id ?? null)

/**
 * Ends exactly the session with `token`, whatever session this browser's cookie holds by now
 * (another tab may have signed in again since); the cookie is cleared only if it's that one.
 * True only when the server says it's done.
 */
async function endSession(token: string): Promise<boolean> {
  try {
    const result = await authClient.revokeSession({
      token,
      fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) },
    })
    return !result?.error
  } catch {
    return false
  }
}

/** Forgets the key, trying a few times: storage that fails once may not the next time. */
async function forgetFirmly(userId: string, options: Parameters<typeof forgetIdentity>[1]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await forgetIdentity(userId, options)
    } catch (e) {
      if (attempt === 3) throw e
    }
  }
}

/**
 * Signs out. Without `userId`, it ends the session the cookie holds: for where no key is kept.
 * With `userId`, it first forgets this device's copy of their key (or only key
 * `onlyKid`; with null, none, though saves under way anywhere are still stopped), noting the
 * session it's ending: from then on no tab keeps a key here for that session, whatever comes of
 * this (lib/keys.ts). Then it ends that session, and only that one. Only once the server confirms
 * it ended does it go to the sign-in page, which says if the key's removal couldn't be confirmed.
 * Otherwise it returns false, for the caller to say so and offer a retry. If the server can't be
 * asked which session this is, nothing is changed.
 */
export async function signOut(userId?: string, { onlyKid }: { onlyKid?: string | null } = {}) {
  if (!userId) {
    const ended = await authClient.signOut({ fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) } }).then(
      (result) => !result?.error,
      () => false,
    )
    if (ended) window.location.assign('/sign-in')
    return ended
  }
  let session: { id: string; token: string } | null
  try {
    session = await currentSession(userId)
  } catch {
    return false
  }
  let unconfirmed = false
  try {
    await forgetFirmly(userId, { onlyKid, endingSession: session?.id })
  } catch {
    unconfirmed = true
  }
  // Not signed in as them any more (signed out elsewhere, or as someone else since): there's no
  // session of theirs to end, and the sign-in page is where this tab belongs.
  if (session && !(await endSession(session.token))) return false
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return true
}
