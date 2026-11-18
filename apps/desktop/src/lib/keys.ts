import { fromBase64Url, ready, toBase64Url, type KeyPair } from '@trioditis/crypto'

/*
 * The person's unwrapped identity key on this device, until they sign out of it. The private key
 * is kept in IndexedDB encrypted with a device key that the browser holds as a non-extractable
 * WebCrypto key, so the stored bytes are useless outside this browser profile. Other devices get
 * the key from the wrapped backups on the server (api.keys), never from here.
 */

const DB_NAME = 'trioditis-keys'
const STORE = 'identity'

interface StoredIdentity {
  userId: string
  kid: string
  publicKey: string
  iv: Uint8Array<ArrayBuffer>
  wrapped: ArrayBuffer
  deviceKey: CryptoKey
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'userId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Runs several requests in one transaction, which `run` chains from their callbacks; `answer`
 * gives the result. It answers once the transaction has committed, and fails if it aborts.
 */
async function inTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, answer: (value: T) => void) => void,
): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      let value: T
      run(transaction.objectStore(STORE), (v) => {
        value = v
      })
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('the change to this device’s storage was undone'))
    })
  } finally {
    db.close()
  }
}

/**
 * Runs one request on the store. It answers once the transaction has committed, not when the
 * request succeeds: a write (keeping or forgetting a key) isn't done until then, and can still
 * be aborted.
 */
async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode)
      const request = run(transaction.objectStore(STORE))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error ?? request.error)
      transaction.onabort = () =>
        reject(transaction.error ?? new Error('the change to this device’s storage was undone'))
    })
  } finally {
    db.close()
  }
}

/**
 * Whether this page can keep a key on this device. The stored copy is encrypted with WebCrypto,
 * which browsers only offer to a secure page: one served over HTTPS, or from localhost.
 */
export function canKeepKeys(): boolean {
  return window.isSecureContext && globalThis.crypto?.subtle !== undefined
}

/** This device's copy of the identity key for `userId`, if it has one. */
export async function loadIdentity(userId: string): Promise<{ kid: string; keyPair: KeyPair } | null> {
  await ready()
  const stored = await withStore<StoredIdentity | undefined>('readonly', (s) => s.get(userId))
  if (!stored) return null
  const privateKey = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, stored.deviceKey, stored.wrapped),
  )
  return { kid: stored.kid, keyPair: { publicKey: fromBase64Url(stored.publicKey), privateKey } }
}

// Changes to a person's stored key are coordinated across every tab of this app, through the
// database itself, so they hold without Web Locks and never wait on the network:
//
// - Each forget bumps a per-person count, in the same transaction as its delete, and a save
//   checks the count it was given (its token) in the same transaction as its write. So work begun
//   before a sign-out never lands after it.
// - Signing out also notes, in that transaction, the session it's ending (lib/sign-out.ts), and
//   only then ends that session. A save asks the server which session it's in first, and writes
//   only for one never noted: so once a sign-out has begun, no save for that session lands, in
//   any tab, ever. If the sign-out fails, that session keeps no key here; signing in again, a new
//   session, can. Each session is noted for good, so one sign-out never undoes another's.
// - After every forget, every tab hears that saves were fenced (onFence), so a tab still signed
//   in takes a new token for new work, and reads its key afresh.
const forgetsKey = (userId: string) => `${userId}\u0000forgets`

interface Forgets {
  count: number
  /** Every session signed out of here, or tried to be, the latest last. */
  endedSessions: string[]
}

/** How many sessions stay noted: far more than anyone signs out of on one device in a session's life. */
const NOTED_SESSIONS = 200

function readForgets(store: IDBObjectStore, userId: string, then: (forgets: Forgets) => void) {
  const request = store.get(forgetsKey(userId))
  request.onsuccess = () => {
    const stored = request.result as (Partial<Forgets> & { endingSession?: string }) | undefined
    // Before every session was kept, only the latest was, as endingSession.
    const ended = stored?.endedSessions ?? (stored?.endingSession ? [stored.endingSession] : [])
    then({ count: stored?.count ?? 0, endedSessions: ended })
  }
}

const writeForgets = (store: IDBObjectStore, userId: string, forgets: Forgets) =>
  store.put({ userId: forgetsKey(userId), ...forgets })

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('trioditis-keys')
const fenceListeners = new Set<(userId: string) => void>()
channel?.addEventListener('message', (event: MessageEvent<{ fenced?: string }>) => {
  if (event.data?.fenced) for (const listener of fenceListeners) listener(event.data.fenced)
})

/** Tells every tab, this one included, that saves for `userId` were fenced: tokens are stale. */
export function announceFence(userId: string) {
  channel?.postMessage({ fenced: userId })
  for (const listener of fenceListeners) listener(userId)
}

/** Calls `onFenced` whenever saves for `userId` are fenced, in any tab. Returns the unsubscribe. */
export function onFence(userId: string, onFenced: () => void): () => void {
  const listener = (fenced: string) => fenced === userId && onFenced()
  fenceListeners.add(listener)
  return () => fenceListeners.delete(listener)
}

/**
 * A token for keeping a key that's about to be worked out (unlocked or set up), passed to
 * storeIdentity: a forget anywhere since it was taken stops the save.
 */
export function saveToken(userId: string): Promise<number> {
  return inTransaction<number>('readonly', (store, answer) => readForgets(store, userId, (f) => answer(f.count)))
}

/** Why a key wasn't kept, each saying what to do about it. */
export type KeepRefusal = 'unreachable' | 'signedOut' | 'fenced' | 'signingOut'

const REFUSALS: Record<KeepRefusal, string> = {
  unreachable: 'the server couldn’t be reached to check you’re still signed in. Try again.',
  signedOut: 'you’ve been signed out meanwhile. Sign in again.',
  fenced: 'signing out was tried in another tab meanwhile. Try again.',
  signingOut: 'signing out of this session was tried on this device. Sign out, then sign in again, to keep it here.',
}

/** A save that was turned away, not one the browser's storage failed. */
export class KeepRefused extends Error {
  readonly why: KeepRefusal
  constructor(why: KeepRefusal) {
    super(REFUSALS[why])
    this.why = why
  }
}

/**
 * Keeps an unwrapped identity key on this device, for the session `currentSession` names (it
 * answers null when signed out, and throws when it can't tell), if that session isn't being
 * signed out of and no forget has happened since `token`. Throws KeepRefused if not.
 */
export async function storeIdentity(
  userId: string,
  kid: string,
  keyPair: KeyPair,
  token: number,
  currentSession: () => Promise<string | null>,
): Promise<void> {
  if (!canKeepKeys()) throw new Error('this page isn’t secure, so the browser offers no WebCrypto here')
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new Uint8Array(keyPair.privateKey))
  const record: StoredIdentity = { userId, kid, publicKey: toBase64Url(keyPair.publicKey), iv, wrapped, deviceKey }
  let session: string | null
  try {
    session = await currentSession()
  } catch {
    throw new KeepRefused('unreachable')
  }
  if (session === null) throw new KeepRefused('signedOut')
  const refused = await inTransaction<KeepRefusal | null>('readwrite', (store, answer) =>
    readForgets(store, userId, (forgets) => {
      const why = forgets.count !== token ? 'fenced' : forgets.endedSessions.includes(session) ? 'signingOut' : null
      answer(why)
      if (!why) store.put(record)
    }),
  )
  if (refused) throw new KeepRefused(refused)
}

/**
 * Forgets this device's key and fences saves begun before it. With `onlyKid`, it removes the
 * stored key only if it's that one: a different key here is someone else's evidence to keep.
 * With `onlyKid` null it removes nothing, and only fences: signing out while a key's backups
 * aren't known to exist. With `endingSession`, saves for that session are refused from then on
 * (for signing out). Every tab hears of it once the forget has committed.
 */
export async function forgetIdentity(
  userId: string,
  { onlyKid, endingSession }: { onlyKid?: string | null; endingSession?: string } = {},
): Promise<void> {
  try {
    await inTransaction<void>('readwrite', (store) =>
      readForgets(store, userId, (forgets) => {
        const ended = forgets.endedSessions.filter((id) => id !== endingSession)
        if (endingSession) ended.push(endingSession)
        writeForgets(store, userId, { count: forgets.count + 1, endedSessions: ended.slice(-NOTED_SESSIONS) })
        if (onlyKid === null) return
        if (onlyKid === undefined) return void store.delete(userId)
        const stored = store.get(userId)
        stored.onsuccess = () => {
          if ((stored.result as StoredIdentity | undefined)?.kid === onlyKid) store.delete(userId)
        }
      }),
    )
  } finally {
    announceFence(userId)
  }
}
