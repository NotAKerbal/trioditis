import { authClient } from './auth-client.ts'
import { announceFence, forgetHeld, withKeyLock } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/** What to say when the server didn't confirm the session ended. */
export const SIGN_OUT_FAILED = 'You’re still signed in: the server couldn’t be reached to sign you out. Try again.'

/** Whether this tab's session is still signed in as `userId`, asked of the server, not a cache. */
export async function stillSignedIn(userId: string): Promise<boolean> {
  const { data } = await authClient.getSession({ query: { disableCookieCache: true } })
  return data?.user.id === userId
}

const endSession = () =>
  authClient.signOut().then(
    (result) => !result?.error,
    () => false,
  )

/**
 * Signs out. With `userId`, it forgets this device's copy of their key (or only key `onlyKid`;
 * with null, none, though saves under way anywhere are still stopped), then ends the session,
 * holding their key lock throughout (lib/keys.ts), so no save in any tab can run until the
 * server has answered, and none after a sign-out that worked. Every tab then hears that saves
 * were fenced, whichever way it went. Only once the server confirms the session ended does it go
 * to the sign-in page, which says if the key's removal couldn't be confirmed. Otherwise it
 * returns false, for the caller to say so and offer a retry: the person is still signed in.
 */
export async function signOut(userId?: string, { onlyKid }: { onlyKid?: string | null } = {}) {
  let unconfirmed = false
  let ended: boolean
  if (userId) {
    try {
      ended = await withKeyLock(userId, async () => {
        try {
          await forgetHeld(userId, onlyKid)
        } catch {
          unconfirmed = true
        }
        return endSession()
      })
    } finally {
      announceFence(userId)
    }
  } else ended = await endSession()
  if (!ended) return false
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return true
}
