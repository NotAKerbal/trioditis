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

// Saving and forgetting a person's key take turns, in the order asked, and forgetting cancels
// every save asked for before it: once forgetting has finished, no save can put the key back,
// however long it took to get ready.
const turns = new Map<string, Promise<unknown>>()
const forgets = new Map<string, number>()

function inTurn<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const next = (turns.get(userId) ?? Promise.resolve()).catch(() => undefined).then(run)
  turns.set(userId, next)
  return next
}

/** Keeps an unwrapped identity key on this device, unless it's forgotten before its turn comes. */
export async function storeIdentity(userId: string, kid: string, keyPair: KeyPair): Promise<void> {
  if (!canKeepKeys()) throw new Error('this page isn’t secure, so the browser offers no WebCrypto here')
  const asked = forgets.get(userId) ?? 0
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new Uint8Array(keyPair.privateKey))
  const record: StoredIdentity = { userId, kid, publicKey: toBase64Url(keyPair.publicKey), iv, wrapped, deviceKey }
  await inTurn(userId, async () => {
    if ((forgets.get(userId) ?? 0) !== asked) throw new Error('this device was signed out of meanwhile')
    await withStore('readwrite', (s) => s.put(record))
  })
}

/** Forgets this device's key, as signing out does, after any save already in turn, and cancels the rest. */
export async function forgetIdentity(userId: string): Promise<void> {
  forgets.set(userId, (forgets.get(userId) ?? 0) + 1)
  await inTurn(userId, () => withStore('readwrite', (s) => s.delete(userId)))
}
