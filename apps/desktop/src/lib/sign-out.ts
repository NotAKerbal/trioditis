import { announceAccountChange } from './account-tabs.ts'
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

/** What to say when this page never learned its session's token, so it can't end it. */
export const SIGN_OUT_SWITCHED =
  'This page couldn’t end your session: who’s signed in on this device may have changed in another tab. Reload the page, then sign out again.'

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
  if (!data) return null
  return { userId: data.user.id, id: data.session.id, token: data.session.token }
}

// The token of the session this page opened with (members.me names it), to end exactly that
// session later. Memory only.
const tokens = new Map<string, string>()
const noting = new Map<string, Promise<'noted' | 'changed' | 'unknown'>>()

/**
 * Notes the token of `sessionId`, the session this page opened with, if it's the one this
 * browser is in: 'noted'. 'changed' if the browser is in another by now (the page should
 * reload), 'unknown' if the server couldn't say (asking again may). Asked as the page opens,
 * and never again once answered.
 */
export function rememberSession(sessionId: string): Promise<'noted' | 'changed' | 'unknown'> {
  let answer = noting.get(sessionId)
  if (!answer) {
    answer = signedIn().then(
      (now) => {
        if (now?.id !== sessionId) return 'changed'
        tokens.set(sessionId, now.token)
        return 'noted'
      },
      () => {
        noting.delete(sessionId)
        return 'unknown' as const
      },
    )
    noting.set(sessionId, answer)
  }
  return answer
}

/** The session this tab is signed in to as `userId` (see signedIn); null if not signed in as them. */
export async function currentSession(userId: string): Promise<SignedIn | null> {
  const now = await signedIn()
  return now?.userId === userId ? now : null
}

/** The ID of the session this tab is signed in to as `userId` (see currentSession). */
export const currentSessionId = (userId: string) => currentSession(userId).then((session) => session?.id ?? null)

/**
 * Ends exactly the session with `token`, whoever this browser's cookie signs in by now
 * (POST /api/auth/end-session, docs/architecture/client-api.md). True when the server says it
 * ended it, or that it had ended already. It sets no cookie, so a late answer can't touch a
 * sign-in made meanwhile in another tab.
 */
async function endSession(token: string): Promise<boolean> {
  try {
    const { data, error } = await authClient.$fetch<{ result: 'ended' | 'absent' }>('/end-session', {
      method: 'POST',
      body: { token },
      signal: AbortSignal.timeout(AUTH_WAIT_MS),
    })
    return !error && (data?.result === 'ended' || data?.result === 'absent')
  } catch {
    return false
  }
}

/**
 * Stops saves of `userId`'s key for `sessionId`, in every tab, removing nothing: the first step
 * of signing out from setup, taken before anything is waited on (see KeyGate). False if it
 * couldn't be recorded.
 */
export const fenceSession = (userId: string, sessionId: string) =>
  forgetFirmly(userId, { onlyKid: null, endingSession: sessionId }).then(
    () => true,
    () => false,
  )

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
 * Signs `userId` out of `sessionId`, the session the page opened with: that one, and no other,
 * whatever session this browser's cookie holds by now.
 *
 * It first forgets this device's copy of their key (or only key `onlyKid`; with null, none,
 * though saves under way anywhere are still stopped), noting the session it's ending: from then
 * on no tab keeps a key here for that session, whatever comes of this (lib/keys.ts). Only once
 * that's recorded does it end the session, by the token noted when the page opened
 * (rememberSession), asking nothing else of the server: no read that could set or clear the
 * cookie. Then every other tab reloads (lib/account-tabs.ts), and this one goes to sign in.
 *
 * Returns null when it went through; otherwise, what to tell the person, who can try again.
 */
export async function signOut(
  userId: string,
  sessionId: string,
  { onlyKid, backedUpKid }: SignOutOptions = {},
): Promise<string | null> {
  let unconfirmed = false
  try {
    await forgetFirmly(userId, { onlyKid, endingSession: sessionId })
  } catch {
    // A save under way could still land after the session ends, so it isn't ended.
    return SIGN_OUT_UNSTORED
  }
  // Noted as the page opened (waiting for that if it's still on its way); never asked for now,
  // when a read could set the cookie back to this session after another tab signed in. Without
  // it nothing more is asked of anyone.
  await noting.get(sessionId)
  const token = tokens.get(sessionId)
  if (!token) return SIGN_OUT_SWITCHED
  // Fenced now, so the key here is the last one that will be: forget it too if its backups have
  // turned out to exist meanwhile (another tab may have finished them, then unlocked).
  if (onlyKid === null && backedUpKid) {
    try {
      const kid = await backedUpKid()
      if (kid) await forgetFirmly(userId, { onlyKid: kid, endingSession: sessionId })
    } catch {
      unconfirmed = true
    }
  }
  if (!(await endSession(token))) return SIGN_OUT_FAILED
  tokens.delete(sessionId)
  announceAccountChange()
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return null
}
