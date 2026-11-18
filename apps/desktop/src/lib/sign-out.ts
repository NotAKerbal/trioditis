import { authClient } from './auth-client.ts'
import { forgetIdentity } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/** What to say when the server didn't confirm the session ended. */
export const SIGN_OUT_FAILED =
  'Signing out didn’t go through, or the server couldn’t confirm it. You may still be signed in here. Try again.'

/** What to say when this device couldn't note the sign-out, so it wasn't sent. */
export const SIGN_OUT_UNSTORED =
  'You’re still signed in: this device couldn’t record the sign-out, so it wasn’t sent. Check that this site may store data, then try again.'

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
 * Asks the server to end exactly the session with `token`, whatever session this browser's
 * cookie holds by now (another tab may have signed in again since). It clears the cookie only if
 * it's that one. Whether it worked is told by asking afterwards (see signOut), not by the answer:
 * the server answers yes when the cookie is someone else's and it ended nothing.
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
 * Signs `userId` out of this device: the session this browser holds for them, and no other.
 *
 * It first forgets this device's copy of their key (or only key `onlyKid`; with null, none,
 * though saves under way anywhere are still stopped), noting the session it's ending: from then
 * on no tab keeps a key here for that session, whatever comes of this (lib/keys.ts). Only once
 * that's recorded does it end the session, and then it asks the server again: this device is
 * signed out once its cookie no longer holds that session. Then it goes to the sign-in page.
 *
 * If they aren't signed in here any more (signed out elsewhere, or someone else signed in since),
 * there's no session of theirs to end: the key is forgotten, and nothing is sent. A session this
 * browser no longer holds, still open on the server, is ended from Settings → Keys and devices.
 *
 * Returns null when it went through; otherwise, what to tell the person, who can try again.
 */
export async function signOut(userId: string, { onlyKid }: { onlyKid?: string | null } = {}): Promise<string | null> {
  let session: { id: string; token: string } | null
  try {
    session = await currentSession(userId)
  } catch {
    return SIGN_OUT_FAILED
  }
  try {
    await forgetFirmly(userId, { onlyKid, endingSession: session?.id })
  } catch {
    // A save under way could still land after the session ends, so it isn't ended. With no
    // session left to end, there's nothing for a save to land under: just say the key may stay.
    if (session) return SIGN_OUT_UNSTORED
    window.location.assign(KEY_UNCONFIRMED)
    return null
  }
  if (session) {
    const answered = await endSession(session.token)
    let after: string | null | undefined
    try {
      after = (await currentSession(userId))?.id ?? null
    } catch {
      after = undefined
    }
    // Still held here, or the server can't say and didn't say it was done: not signed out.
    if (after === session.id || (after === undefined && !answered)) return SIGN_OUT_FAILED
  }
  window.location.assign('/sign-in')
  return null
}
