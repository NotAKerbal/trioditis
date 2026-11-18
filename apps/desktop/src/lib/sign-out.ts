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

/** What to say when someone else is signed in here now, so the server can't say their session ended. */
export const SIGN_OUT_SWITCHED =
  'Someone else has signed in on this device since, in another tab, so it couldn’t be confirmed that your session ended. Sign in as yourself again, then sign out, to be sure.'

/** How long a call to the auth server may take before it's given up on. */
export const AUTH_WAIT_MS = 10_000

interface SignedIn {
  userId: string
  id: string
  token: string
}

/**
 * Who this browser is signed in as, and in which session, asked of the server, not a cache;
 * null if no one. Throws if the server can't be reached or doesn't answer within AUTH_WAIT_MS.
 */
async function signedIn(): Promise<SignedIn | null> {
  const { data, error } = await authClient.getSession({
    query: { disableCookieCache: true },
    fetchOptions: { signal: AbortSignal.timeout(AUTH_WAIT_MS) },
  })
  if (error) throw new Error(error.message ?? 'the server couldn’t say who’s signed in')
  return data ? { userId: data.user.id, id: data.session.id, token: data.session.token } : null
}

/** The session this tab is signed in to as `userId` (see signedIn); null if not signed in as them. */
export async function currentSession(userId: string): Promise<SignedIn | null> {
  const now = await signedIn()
  return now?.userId === userId ? now : null
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

interface SignOutOptions {
  /** Forget only this key (null: none) rather than whatever is here. */
  onlyKid?: string | null
  /**
   * With `onlyKid` null: once saves are fenced, the key whose backups are known to exist now,
   * to forget after all if it's the one here. Null if none; throws if it can't be told.
   */
  backedUpKid?: () => Promise<string | null>
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
 * If they aren't signed in here any more, there's no session of theirs to end: the key is
 * forgotten, and nothing is sent. If someone else is signed in here now, the server can't say
 * whether their session ended, and it says so.
 *
 * Returns null when it went through; otherwise, what to tell the person, who can try again.
 */
export async function signOut(userId: string, { onlyKid, backedUpKid }: SignOutOptions = {}): Promise<string | null> {
  let before: SignedIn | null
  try {
    before = await signedIn()
  } catch {
    return SIGN_OUT_FAILED
  }
  const session = before?.userId === userId ? before : null
  let unconfirmed = false
  try {
    await forgetFirmly(userId, { onlyKid, endingSession: session?.id })
  } catch {
    // A save under way could still land after the session ends, so it isn't ended. With no
    // session left to end, there's nothing for a save to land under: just say the key may stay.
    if (session) return SIGN_OUT_UNSTORED
    unconfirmed = true
  }
  // Fenced now, so the key here is the last one that will be: forget it too if its backups have
  // turned out to exist meanwhile (another tab may have finished them, then unlocked).
  if (onlyKid === null && backedUpKid && !unconfirmed) {
    try {
      const kid = await backedUpKid()
      if (kid) await forgetFirmly(userId, { onlyKid: kid, endingSession: session?.id })
    } catch {
      unconfirmed = true
    }
  }
  if (session) {
    const answered = await endSession(session.token)
    let after: SignedIn | null
    try {
      after = await signedIn()
    } catch {
      return SIGN_OUT_FAILED
    }
    if (after && after.userId !== userId) return SIGN_OUT_SWITCHED
    // Still held here, or ended only if the server said so: they've signed in again meanwhile,
    // in another tab, and that session is the one the cookie holds now.
    if (after?.id === session.id || (after && !answered)) return SIGN_OUT_FAILED
  } else if (before) return SIGN_OUT_SWITCHED
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return null
}
