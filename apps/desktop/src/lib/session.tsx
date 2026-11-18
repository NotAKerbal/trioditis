import type { KeyPair } from '@trioditis/crypto'
import { createContext, useContext } from 'react'

/** Who is signed in on this device, with their unlocked identity key. Only exists inside the app gate. */
export interface Session {
  userId: string
  /** The Better Auth session this page is signed in with (members.me), to sign out of it. */
  sessionId: string
  role: 'admin' | 'member'
  kid: string
  keyPair: KeyPair
}

export const SessionContext = createContext<Session | null>(null)

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession is only available inside the signed-in app')
  return session
}
