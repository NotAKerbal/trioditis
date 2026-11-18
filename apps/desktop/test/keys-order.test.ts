import { generateKeyPair, keyId, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'

// A small in-memory IndexedDB: one store keyed by userId. A request's change lands, and its
// transaction completes, on a later tick, as in a browser.
function fakeIndexedDB() {
  const rows = new Map<string, unknown>()
  const later = (fn: () => void) => setTimeout(fn, 2)
  const store = (tx: { oncomplete?: () => void }) => {
    const request = (apply: () => unknown) => {
      const r: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {}
      later(() => {
        r.result = apply()
        r.onsuccess?.()
        later(() => tx.oncomplete?.())
      })
      return r
    }
    return {
      get: (key: string) => request(() => rows.get(key)),
      put: (value: { userId: string }) => request(() => rows.set(value.userId, value)),
      delete: (key: string) => request(() => rows.delete(key)),
    }
  }
  return {
    rows,
    open: () => {
      const r: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = {}
      later(() => {
        r.result = {
          transaction: () => {
            const tx: { oncomplete?: () => void; objectStore?: unknown } = {}
            tx.objectStore = () => store(tx)
            return tx
          },
          close: () => undefined,
        }
        r.onsuccess?.()
      })
      return r
    },
  }
}

const db = fakeIndexedDB()
Object.assign(globalThis, { indexedDB: db, window: { isSecureContext: true } })
const { forgetIdentity, loadIdentity, storeIdentity } = await import('../src/lib/keys.ts')

describe('keeping and forgetting the key on this device', () => {
  beforeAll(ready)

  it('forgets a key whose save was still getting ready, so it never comes back', async () => {
    const keyPair = generateKeyPair()
    const save = storeIdentity('u1', keyId(keyPair.publicKey), keyPair)
    // Signing out while the save is still encrypting.
    await forgetIdentity('u1')
    await expect(save).rejects.toThrow('signed out of meanwhile')
    expect(await loadIdentity('u1')).toBeNull()
  })

  it('forgets a key that was saved first', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u2', keyId(keyPair.publicKey), keyPair)
    expect((await loadIdentity('u2'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u2')
    expect(await loadIdentity('u2')).toBeNull()
  })

  it('keeps a key saved after forgetting, as signing in again does', async () => {
    const keyPair = generateKeyPair()
    await forgetIdentity('u3')
    await storeIdentity('u3', keyId(keyPair.publicKey), keyPair)
    expect((await loadIdentity('u3'))?.kid).toBe(keyId(keyPair.publicKey))
  })
})
