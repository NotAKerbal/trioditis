import { authClient } from './auth-client.ts'
import { forgetIdentity } from './keys.ts'

/** The sign-in page's address after a sign-out whose key removal couldn't be confirmed. */
export const KEY_UNCONFIRMED = '/sign-in?key=unconfirmed'

/**
 * Signs out: forgets this device's copy of `userId`'s key, when given, once `waitFor` (a save
 * still under way) has settled, so it can't be put back afterwards. The session ends even if
 * the key couldn't be removed; the sign-in page then says so, as it can't be sure.
 */
export async function signOut(userId?: string, { waitFor }: { waitFor?: Promise<unknown> | null } = {}) {
  await waitFor?.catch(() => undefined)
  let unconfirmed = false
  if (userId) {
    try {
      await forgetIdentity(userId)
    } catch {
      unconfirmed = true
    }
  }
  await authClient.signOut().catch(() => undefined)
  window.location.assign(unconfirmed ? KEY_UNCONFIRMED : '/sign-in')
}
