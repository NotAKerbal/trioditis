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
const { forgetHeld, forgetIdentity, loadIdentity, onFence, saveToken, storeIdentity, withKeyLock } =
  await import('../src/lib/keys.ts')
const signedIn = async () => true

describe('keeping and forgetting the key on this device', () => {
  beforeAll(ready)

  it('forgets a key whose save was still getting ready, so it never comes back', async () => {
    const keyPair = generateKeyPair()
    const save = storeIdentity('u1', keyId(keyPair.publicKey), keyPair, await saveToken('u1'), signedIn)
    // Signing out while the save is still encrypting.
    await forgetIdentity('u1')
    await expect(save).rejects.toThrow('signed out of meanwhile')
    // Checked in the database itself: another tab's save would be refused the same way.
    expect(await loadIdentity('u1')).toBeNull()
  })

  it('forgets a key that was saved first', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u2', keyId(keyPair.publicKey), keyPair, await saveToken('u2'), signedIn)
    expect((await loadIdentity('u2'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u2')
    expect(await loadIdentity('u2')).toBeNull()
  })

  it('forgets only the named key, leaving another one here alone', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u4', keyId(keyPair.publicKey), keyPair, await saveToken('u4'), signedIn)
    await forgetIdentity('u4', 'some-other-key')
    expect((await loadIdentity('u4'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u4', keyId(keyPair.publicKey))
    expect(await loadIdentity('u4')).toBeNull()
  })

  it('refuses a save whose work began before a sign-out elsewhere, though it reaches storage after', async () => {
    // Unlocking in one tab takes its token, then waits (deriving the key); meanwhile another
    // tab signs out. The save that follows mustn't put the key back.
    const keyPair = generateKeyPair()
    const token = await saveToken('u5')
    await forgetIdentity('u5')
    await expect(storeIdentity('u5', keyId(keyPair.publicKey), keyPair, token, signedIn)).rejects.toThrow(
      'signed out of meanwhile',
    )
    expect(await loadIdentity('u5')).toBeNull()
  })

  it('stops saves under way without removing anything, for a sign-out unsure of the backups', async () => {
    const kept = generateKeyPair()
    await storeIdentity('u6', keyId(kept.publicKey), kept, await saveToken('u6'), signedIn)
    const token = await saveToken('u6')
    await forgetIdentity('u6', null)
    // The key already here stays; a save from before the sign-out doesn't land.
    expect((await loadIdentity('u6'))?.kid).toBe(keyId(kept.publicKey))
    const other = generateKeyPair()
    await expect(storeIdentity('u6', keyId(other.publicKey), other, token, signedIn)).rejects.toThrow(
      'signed out of meanwhile',
    )
    expect((await loadIdentity('u6'))?.kid).toBe(keyId(kept.publicKey))
  })

  it('keeps a key saved after forgetting, as signing in again does', async () => {
    const keyPair = generateKeyPair()
    await forgetIdentity('u3')
    await storeIdentity('u3', keyId(keyPair.publicKey), keyPair, await saveToken('u3'), signedIn)
    expect((await loadIdentity('u3'))?.kid).toBe(keyId(keyPair.publicKey))
  })

  it('refuses a save once the session has ended, though no sign-out was seen here', async () => {
    // Signed out elsewhere, say, by the server ending the session: the save asks before writing.
    const keyPair = generateKeyPair()
    const token = await saveToken('u7')
    await expect(storeIdentity('u7', keyId(keyPair.publicKey), keyPair, token, async () => false)).rejects.toThrow(
      'signed out of meanwhile',
    )
    // An unanswerable check counts as signed out too.
    const failing = async () => Promise.reject(new Error('offline'))
    await expect(storeIdentity('u7', keyId(keyPair.publicKey), keyPair, token, failing)).rejects.toThrow(
      'signed out of meanwhile',
    )
    expect(await loadIdentity('u7')).toBeNull()
  })

  it('holds a save back while a sign-out is under way, then asks whether it worked', async () => {
    // Another tab has forgotten the key and is waiting on the server to end the session.
    const keyPair = generateKeyPair()
    const token = await saveToken('u8')
    let answer!: () => void
    const serverAnswered = new Promise<void>((resolve) => (answer = resolve))
    let ended = false
    const signingOut = withKeyLock('u8', async () => {
      await forgetHeld('u8')
      await serverAnswered
      ended = true
    })
    const asked: boolean[] = []
    const save = storeIdentity('u8', keyId(keyPair.publicKey), keyPair, token, async () => {
      asked.push(ended)
      return !ended
    })
    const later = saveToken('u8')
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Neither the save nor a new token gets past the lock until the server has answered.
    expect(asked).toEqual([])
    answer()
    await signingOut
    await expect(save).rejects.toThrow('signed out of meanwhile')
    expect(asked).toEqual([true])
    // A token taken after the sign-out keeps what's worked out from then on.
    await storeIdentity('u8', keyId(keyPair.publicKey), keyPair, await later, signedIn)
    expect((await loadIdentity('u8'))?.kid).toBe(keyId(keyPair.publicKey))
  })

  it('tells this tab and every other one that saves were fenced', async () => {
    const heard: string[] = []
    const stop = onFence('u9', () => heard.push('here'))
    onFence('someone-else', () => heard.push('wrong person'))
    const elsewhere = new BroadcastChannel('trioditis-keys')
    const reached = new Promise<unknown>((resolve) => elsewhere.addEventListener('message', (e) => resolve(e.data)))
    await forgetIdentity('u9', null)
    expect(await reached).toEqual({ fenced: 'u9' })
    expect(heard).toEqual(['here'])
    stop()
    elsewhere.close()
  })
})
