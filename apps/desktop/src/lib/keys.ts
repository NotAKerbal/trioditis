import { fromBase64Url, generateKeyPair, keyId, ready, toBase64Url, type KeyPair } from '@trioditis/crypto'

/*
 * The person's identity key on this device. The private key never leaves the device: it is
 * kept in IndexedDB, encrypted with a device key that the browser holds as a non-extractable
 * WebCrypto key, so the stored bytes are useless without this browser profile.
 *
 * Restoring the key on another device needs the recovery-key backup, which needs a wrapped
 * copy stored on the server. The backend doesn't store one yet (see "Needs from backend"), so
 * for now a key lives only on the device that made it.
 */

const DB_NAME = 'trioditis-keys'
const STORE = 'identity'

interface StoredIdentity {
  userId: string
  kid: string
  publicKey: string
  iv: Uint8Array
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

/** This device's identity key for `userId`, if it has one. */
export async function loadIdentity(userId: string): Promise<{ kid: string; keyPair: KeyPair } | null> {
  await ready()
  const stored = await withStore<StoredIdentity | undefined>('readonly', (s) => s.get(userId))
  if (!stored) return null
  const privateKey = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, stored.deviceKey, stored.wrapped))
  return { kid: stored.kid, keyPair: { publicKey: fromBase64Url(stored.publicKey), privateKey } }
}

/** Makes a new identity key on this device and stores it. Returns the public key to register. */
export async function createIdentity(userId: string): Promise<{ kid: string; publicKey: string; keyPair: KeyPair }> {
  await ready()
  const keyPair = generateKeyPair()
  const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, keyPair.privateKey)
  const publicKey = toBase64Url(keyPair.publicKey)
  const kid = keyId(keyPair.publicKey)
  const record: StoredIdentity = { userId, kid, publicKey, iv, wrapped, deviceKey }
  await withStore('readwrite', (s) => s.put(record))
  return { kid, publicKey, keyPair }
}

/** Forgets this device's key, as signing out of the device does. */
export async function forgetIdentity(userId: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(userId))
}
