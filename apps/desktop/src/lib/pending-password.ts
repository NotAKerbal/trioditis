// The password just typed on the sign-in or sign-up screen, held in memory for the moment it
// takes to unlock (or wrap) the identity key, so the person isn't asked for it twice. It is
// taken once and never stored.
let pending: string | null = null

export function holdPassword(password: string) {
  pending = password
  // Not needed after the next screen; don't keep it around if that screen never comes.
  setTimeout(() => {
    pending = null
  }, 60_000)
}

export function takePassword(): string | null {
  const value = pending
  pending = null
  return value
}
