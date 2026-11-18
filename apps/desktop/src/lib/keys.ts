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
 * Runs one request on the store. It answers once the transaction has committed, not when the
 * request succeeds: a write (keeping or forgetting a key) isn't done until then, and can still
 * be aborted.
 */
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

// Saving and forgetting a person's key are ordered through the database itself, so they hold
// across tabs too: each forget bumps a per-person count, in the same transaction as the delete,
// and a save writes only if the count is still what it was when the save began, checked in the
// same transaction as the write. Once forgetting has committed, no save asked for before it can
// put the key back, however long its encryption took, in this tab or another.
const forgetsKey = (userId: string) => `${userId}\u0000forgets`

function forgetCount(store: IDBObjectStore, userId: string, then: (count: number) => void) {
  const request = store.get(forgetsKey(userId))
  request.onsuccess = () => then((request.result as { count?: number } | undefined)?.count ?? 0)
}

/**
 * A token for keeping a key that's about to be worked out (unlocked or set up): taken when that
 * work begins and passed to storeIdentity, so a sign-out anywhere since, in any tab, stops the
 * save, not only one during the save itself.
 */
export function saveToken(userId: string): Promise<number> {
  return inTransaction<number>('readonly', (store, answer) => forgetCount(store, userId, answer))
}

/** Keeps an unwrapped identity key on this device, unless it's been forgotten since `token`. */
export async function storeIdentity(userId: string, kid: string, keyPair: KeyPair, token: number): Promise<void> {
  if (!canKeepKeys()) throw new Error('this page isn’t secure, so the browser offers no WebCrypto here')
  const asked = token
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new Uint8Array(keyPair.privateKey))
  const record: StoredIdentity = { userId, kid, publicKey: toBase64Url(keyPair.publicKey), iv, wrapped, deviceKey }
  const written = await inTransaction<boolean>('readwrite', (store, answer) =>
    forgetCount(store, userId, (count) => {
      answer(count === asked)
      if (count === asked) store.put(record)
    }),
  )
  if (!written) throw new Error('this device was signed out of meanwhile')
}

/**
 * Forgets this device's key, as signing out does, and stops any save asked for before it, in
 * any tab. With `onlyKid`, it removes the stored key only if it's that one: a different key here
 * is someone else's evidence to keep. With `onlyKid` null it removes nothing, and only stops
 * those saves: signing out while a key's backups aren't known to exist.
 */
export async function forgetIdentity(userId: string, onlyKid?: string | null): Promise<void> {
  await inTransaction<void>('readwrite', (store) =>
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
