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

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
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

/** Keeps an unwrapped identity key on this device. */
export async function storeIdentity(userId: string, kid: string, keyPair: KeyPair): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, new Uint8Array(keyPair.privateKey))
  const record: StoredIdentity = { userId, kid, publicKey: toBase64Url(keyPair.publicKey), iv, wrapped, deviceKey }
  await withStore('readwrite', (s) => s.put(record))
}

/** Forgets this device's key, as signing out does. */
export async function forgetIdentity(userId: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(userId))
}
