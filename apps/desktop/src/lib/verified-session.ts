import type { KeyPair } from '@trioditis/crypto'
import type { Session } from './session.tsx'

/*
 * The last session the server confirmed on this device: who, in which session, with which role
 * and key. Only IDs, never anything of a chat, a contact or a message. It lets the app open with
 * the key this device keeps when it starts with no connection (a cold start offline), instead of
 * waiting on the server forever. Once the server answers, the app goes through the gate as
 * usual, and a session that has ended, or an account that's no longer a member, is signed out.
 */

export interface VerifiedSession {
  userId: string
  sessionId: string
  role: 'admin' | 'member'
  kid: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null

const KEY = 'trioditis-verified-session'

/** How long a start with a connection waits on the server before opening from this device. */
export const COLD_START_MS = 4_000

function local(): Store {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function rememberVerified(session: VerifiedSession, store: Store = local()) {
  const { userId, sessionId, role, kid } = session
  try {
    store?.setItem(KEY, JSON.stringify({ userId, sessionId, role, kid }))
  } catch {
    // Without it, a cold start offline waits for the server, as before.
  }
}

export function readVerified(store: Store = local()): VerifiedSession | null {
  try {
    const value = JSON.parse(store?.getItem(KEY) ?? 'null') as Partial<VerifiedSession> | null
    if (
      !value ||
      typeof value.userId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.kid !== 'string' ||
      (value.role !== 'admin' && value.role !== 'member')
    ) {
      return null
    }
    return { userId: value.userId, sessionId: value.sessionId, role: value.role, kid: value.kid }
  } catch {
    return null
  }
}

export function forgetVerified(store: Store = local()) {
  try {
    store?.removeItem(KEY)
  } catch {
    // Nothing more to do; it holds only IDs.
  }
}

/**
 * The session to open with on a cold start: the last one confirmed, if this device still keeps
 * that account's key (a sign-out here removes it) and it's the same key.
 */
export function coldSession(
  verified: VerifiedSession | null,
  kept: { kid: string; keyPair: KeyPair } | null,
): Session | null {
  if (!verified || !kept || kept.kid !== verified.kid) return null
  return { ...verified, keyPair: kept.keyPair, offline: true }
}
