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

// Changes to a person's stored key are coordinated across every tab of this app:
//
// - A lock (Web Locks, per person) runs them one at a time, and signing out holds it from the
//   moment it forgets the key until the server has answered (lib/sign-out.ts). So no save runs
//   while a sign-out is under way, in any tab; it waits until the sign-out is over.
// - A save then writes only if the session it was worked out for is still signed in (asked of
//   the server, inside the lock), and only if no sign-out has happened since its work began: each
//   forget bumps a per-person count, in the same transaction as its delete, and the save checks
//   the count it was given (its token) in the same transaction as its write.
// - After every sign-out attempt, whether it worked or not, every tab hears that saves were
//   fenced (onFence), so a tab still signed in takes a new token for new work, and reads its key
//   afresh, while work begun before the fence stays fenced.
const forgetsKey = (userId: string) => `${userId}\u0000forgets`

function forgetCount(store: IDBObjectStore, userId: string, then: (count: number) => void) {
  const request = store.get(forgetsKey(userId))
  request.onsuccess = () => then((request.result as { count?: number } | undefined)?.count ?? 0)
}

const inTab = new Map<string, Promise<unknown>>()

/**
 * Runs `run` holding this person's key lock, across every tab. Where the browser has no Web
 * Locks, it orders them within this tab only. Not re-entrant: never call it from inside `run`.
 */
export function withKeyLock<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks
  if (locks) return locks.request(`trioditis-key:${userId}`, { mode: 'exclusive' }, run) as Promise<T>
  const next = (inTab.get(userId) ?? Promise.resolve()).catch(() => undefined).then(run)
  inTab.set(userId, next)
  return next
}

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
 * storeIdentity: a sign-out anywhere since it was taken stops the save. Taking it waits for a
 * sign-out under way to be over.
 */
export function saveToken(userId: string): Promise<number> {
  return withKeyLock(userId, () =>
    inTransaction<number>('readonly', (store, answer) => forgetCount(store, userId, answer)),
  )
}

/**
 * Keeps an unwrapped identity key on this device, if `stillSignedIn` says the session is, and no
 * sign-out has happened since `token`. Both are checked holding the key lock.
 */
export async function storeIdentity(
  userId: string,
  kid: string,
  keyPair: KeyPair,
  token: number,
  stillSignedIn: () => Promise<boolean>,
): Promise<void> {
  if (!canKeepKeys()) throw new Error('this page isn’t secure, so the browser offers no WebCrypto here')
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new Uint8Array(keyPair.privateKey))
  const record: StoredIdentity = { userId, kid, publicKey: toBase64Url(keyPair.publicKey), iv, wrapped, deviceKey }
  const written = await withKeyLock(userId, async () => {
    if (!(await stillSignedIn().catch(() => false))) return false
    return inTransaction<boolean>('readwrite', (store, answer) =>
      forgetCount(store, userId, (count) => {
        answer(count === token)
        if (count === token) store.put(record)
      }),
    )
  })
  if (!written) throw new Error('this device was signed out of meanwhile')
}

/**
 * Forgets this device's key and fences saves begun before it, without taking the key lock: for
 * signing out, which holds it already (lib/sign-out.ts). With `onlyKid`, it removes the stored key
 * only if it's that one: a different key here is someone else's evidence to keep. With `onlyKid`
 * null it removes nothing, and only fences: signing out while a key's backups aren't known to exist.
 */
export function forgetHeld(userId: string, onlyKid?: string | null): Promise<void> {
  return inTransaction<void>('readwrite', (store) =>
    forgetCount(store, userId, (count) => {
      store.put({ userId: forgetsKey(userId), count: count + 1 })
      if (onlyKid === null) return
      if (onlyKid === undefined) return void store.delete(userId)
      const stored = store.get(userId)
      stored.onsuccess = () => {
        if ((stored.result as StoredIdentity | undefined)?.kid === onlyKid) store.delete(userId)
      }
    }),
  )
}

/** Forgets this device's key (see forgetHeld), holding the key lock, and tells every tab. */
export async function forgetIdentity(userId: string, onlyKid?: string | null): Promise<void> {
  try {
    await withKeyLock(userId, () => forgetHeld(userId, onlyKid))
  } finally {
    announceFence(userId)
  }
}
