// The password just typed on the sign-in or sign-up screen, held in memory for the moment it
// takes to unlock (or wrap) the identity key, so the person isn't asked for it twice. It is
// taken once, only for the account it was typed for, and never stored.
let pending: { password: string; userId: string } | null = null

export function holdPassword(password: string, userId: string) {
  pending = { password, userId }
  // Not needed after the next screen; don't keep it around if that screen never comes.
  setTimeout(() => {
    pending = null
  }, 60_000)
}

/** The password held for `userId`; null if none, or if it was typed for someone else. */
export function takePassword(userId: string): string | null {
  const value = pending?.userId === userId ? pending.password : null
  pending = null
  return value
}
