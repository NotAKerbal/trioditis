import { generateKeyPair, keyId, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'

// A small in-memory IndexedDB: one store keyed by userId. Each request's change lands on a later
// tick, and a transaction completes once no request is left in it (those its callbacks start
// count too), as in a browser; transactions run one after another.
function fakeIndexedDB() {
  const rows = new Map<string, unknown>()
  const later = (fn: () => void) => setTimeout(fn, 2)
  let queue = Promise.resolve()
  const transaction = () => {
    const tx: { oncomplete?: () => void; objectStore?: unknown } = {}
    let pending = 0
    let started!: () => void
    const turn = new Promise<void>((resolve) => (started = resolve))
    queue = queue.then(() => {
      started()
      return new Promise<void>((done) => {
        const finish = tx.oncomplete
        tx.oncomplete = undefined
        const check = () =>
          later(() => {
            if (pending === 0) {
              finish?.()
              ;(tx.oncomplete ?? (() => undefined))()
              done()
            }
          })
        ;(tx as { check?: () => void }).check = check
      })
    })
    const request = (apply: () => unknown) => {
      pending++
      const r: { result?: unknown; onsuccess?: () => void } = {}
      void turn.then(() =>
        later(() => {
          r.result = apply()
          r.onsuccess?.()
          pending--
          ;(tx as { check?: () => void }).check?.()
        }),
      )
      return r
    }
    tx.objectStore = () => ({
      get: (key: string) => request(() => rows.get(key)),
      put: (value: { userId: string }) => request(() => rows.set(value.userId, value)),
      delete: (key: string) => request(() => rows.delete(key)),
    })
    return tx
  }
  return {
    rows,
    open: () => {
      const r: { result?: unknown; onsuccess?: () => void } = {}
      later(() => {
        r.result = { transaction, close: () => undefined }
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
    // Checked in the database itself: another tab's save would be refused the same way.
    expect(await loadIdentity('u1')).toBeNull()
  })

  it('forgets a key that was saved first', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u2', keyId(keyPair.publicKey), keyPair)
    expect((await loadIdentity('u2'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u2')
    expect(await loadIdentity('u2')).toBeNull()
  })

  it('forgets only the named key, leaving another one here alone', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u4', keyId(keyPair.publicKey), keyPair)
    await forgetIdentity('u4', 'some-other-key')
    expect((await loadIdentity('u4'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u4', keyId(keyPair.publicKey))
    expect(await loadIdentity('u4')).toBeNull()
  })

  it('keeps a key saved after forgetting, as signing in again does', async () => {
    const keyPair = generateKeyPair()
    await forgetIdentity('u3')
    await storeIdentity('u3', keyId(keyPair.publicKey), keyPair)
    expect((await loadIdentity('u3'))?.kid).toBe(keyId(keyPair.publicKey))
  })
})
