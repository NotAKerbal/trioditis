import { authClient } from './auth-client.ts'
import { forgetIdentity } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/** What to say when the server didn't confirm the session ended. */
export const SIGN_OUT_FAILED = 'You’re still signed in: the server couldn’t be reached to sign you out. Try again.'

/**
 * Signs out: forgets this device's copy of `userId`'s key (or only key `onlyKid`), when given, once `waitFor` (a save
 * still under way) has settled, so it can't be put back afterwards. Then ends the session, and
 * only once the server confirms that goes to the sign-in page, which says if the key's removal
 * couldn't be confirmed. Otherwise it returns false, for the caller to say so and offer a retry:
 * the person is still signed in.
 */
export async function signOut(
  userId?: string,
  { waitFor, onlyKid }: { waitFor?: Promise<unknown> | null; onlyKid?: string | null } = {},
) {
  await waitFor?.catch(() => undefined)
  let unconfirmed = false
  if (userId) {
    try {
      // With `onlyKid`, only that key is forgotten: a different one here isn't known to be backed
      // up. With null, none is, but saves still under way anywhere are stopped.
      await forgetIdentity(userId, onlyKid)
    } catch {
      unconfirmed = true
    }
  }
  const ended = await authClient.signOut().then(
    (result) => !result?.error,
    () => false,
  )
  if (!ended) return false
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
  return true
}
