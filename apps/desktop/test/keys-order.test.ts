import { generateKeyPair, keyId, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'

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

// The auth server, as lib/sign-out.ts sees it: who's signed in, and how signing out goes.
const auth = vi.hoisted(() => ({
  session: { user: { id: 'u' }, session: { id: 'S' } } as { user: { id: string }; session: { id: string } } | null,
  sessionFails: false,
  signOut: (): Promise<{ error: { status?: number; message?: string } | null }> => Promise.resolve({ error: null }),
}))
vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: {
    getSession: async () => {
      if (auth.sessionFails) throw new TypeError('Failed to fetch')
      return { data: auth.session, error: null }
    },
    signOut: () => auth.signOut(),
  },
}))

const db = fakeIndexedDB()
const location = { assign: vi.fn() }
Object.assign(globalThis, { indexedDB: db, window: { isSecureContext: true, location } })
const keys = await import('../src/lib/keys.ts')
const { forgetIdentity, KeepRefused, loadIdentity, onFence, saveToken, sessionLivesOn, storeIdentity } = keys
const { signOut } = await import('../src/lib/sign-out.ts')
// Another tab: the same modules loaded afresh, sharing only the database (and BroadcastChannel).
vi.resetModules()
const otherTab = await import('../src/lib/keys.ts')

const inSession = (id: string) => async () => id
const refusal = (why: string) => expect.objectContaining({ why })
const later = <T>() => {
  let settle!: (value: T) => void
  const promise = new Promise<T>((resolve) => (settle = resolve))
  return { promise, settle }
}

describe('keeping and forgetting the key on this device', () => {
  beforeAll(ready)

  it('forgets a key whose save was still getting ready, so it never comes back', async () => {
    const keyPair = generateKeyPair()
    const save = storeIdentity('u1', keyId(keyPair.publicKey), keyPair, await saveToken('u1'), inSession('S'))
    // Signing out while the save is still encrypting.
    await forgetIdentity('u1')
    await expect(save).rejects.toEqual(refusal('fenced'))
    // Checked in the database itself: another tab's save would be refused the same way.
    expect(await loadIdentity('u1')).toBeNull()
  })

  it('forgets a key that was saved first', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u2', keyId(keyPair.publicKey), keyPair, await saveToken('u2'), inSession('S'))
    expect((await loadIdentity('u2'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u2')
    expect(await loadIdentity('u2')).toBeNull()
  })

  it('forgets only the named key, leaving another one here alone', async () => {
    const keyPair = generateKeyPair()
    await storeIdentity('u4', keyId(keyPair.publicKey), keyPair, await saveToken('u4'), inSession('S'))
    await forgetIdentity('u4', { onlyKid: 'some-other-key' })
    expect((await loadIdentity('u4'))?.kid).toBe(keyId(keyPair.publicKey))
    await forgetIdentity('u4', { onlyKid: keyId(keyPair.publicKey) })
    expect(await loadIdentity('u4')).toBeNull()
  })

  it('refuses a save whose work began before a sign-out elsewhere, though it reaches storage after', async () => {
    // Unlocking in one tab takes its token, then waits (deriving the key); meanwhile another
    // tab signs out. The save that follows mustn't put the key back.
    const keyPair = generateKeyPair()
    const token = await otherTab.saveToken('u5')
    await forgetIdentity('u5')
    await expect(
      otherTab.storeIdentity('u5', keyId(keyPair.publicKey), keyPair, token, inSession('S')),
    ).rejects.toEqual(refusal('fenced'))
    expect(await loadIdentity('u5')).toBeNull()
  })

  it('stops saves under way without removing anything, for a sign-out unsure of the backups', async () => {
    const kept = generateKeyPair()
    await storeIdentity('u6', keyId(kept.publicKey), kept, await saveToken('u6'), inSession('S'))
    const token = await saveToken('u6')
    await forgetIdentity('u6', { onlyKid: null })
    // The key already here stays; a save from before the sign-out doesn't land.
    expect((await loadIdentity('u6'))?.kid).toBe(keyId(kept.publicKey))
    const other = generateKeyPair()
    await expect(storeIdentity('u6', keyId(other.publicKey), other, token, inSession('S'))).rejects.toEqual(
      refusal('fenced'),
    )
    expect((await loadIdentity('u6'))?.kid).toBe(keyId(kept.publicKey))
  })

  it('keeps a key saved after forgetting, as signing in again does', async () => {
    const keyPair = generateKeyPair()
    await forgetIdentity('u3')
    await storeIdentity('u3', keyId(keyPair.publicKey), keyPair, await saveToken('u3'), inSession('S'))
    expect((await loadIdentity('u3'))?.kid).toBe(keyId(keyPair.publicKey))
  })

  it('refuses a save once the session has ended, or when the server can’t say', async () => {
    const keyPair = generateKeyPair()
    const token = await saveToken('u7')
    const save = (session: () => Promise<string | null>) =>
      storeIdentity('u7', keyId(keyPair.publicKey), keyPair, token, session)
    await expect(save(async () => null)).rejects.toEqual(refusal('signedOut'))
    await expect(save(() => Promise.reject(new Error('offline')))).rejects.toEqual(refusal('unreachable'))
    expect(await loadIdentity('u7')).toBeNull()
  })

  it('keeps nothing for a session being signed out of, in any tab, until the server says it lives on', async () => {
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    await forgetIdentity('u8', { endingSession: 'S' })
    // Another tab took its token after the forget, and is still in session S as far as it knows.
    await expect(
      otherTab.storeIdentity('u8', kid, keyPair, await otherTab.saveToken('u8'), inSession('S')),
    ).rejects.toEqual(refusal('signingOut'))
    // A new session, signed in since, isn't the one being ended.
    await storeIdentity('u8', kid, keyPair, await saveToken('u8'), inSession('S2'))
    await forgetIdentity('u8')
    // Once the server says S wasn't ended, it may keep keys again.
    await sessionLivesOn('u8', 'S')
    await otherTab.storeIdentity('u8', kid, keyPair, await otherTab.saveToken('u8'), inSession('S'))
    expect((await loadIdentity('u8'))?.kid).toBe(kid)
  })

  it('tells this tab and every other one that saves were fenced', async () => {
    const heard: string[] = []
    const stop = onFence('u9', () => heard.push('here'))
    onFence('someone-else', () => heard.push('wrong person'))
    const elsewhere = new Promise<void>((resolve) => otherTab.onFence('u9', resolve))
    await forgetIdentity('u9', { onlyKid: null })
    await elsewhere
    expect(heard).toEqual(['here'])
    stop()
  })
})

describe('signing out, as the key on this device sees it', () => {
  beforeAll(ready)

  async function keptHere(userId: string) {
    auth.session = { user: { id: userId }, session: { id: `session-of-${userId}` } }
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    await storeIdentity(userId, kid, keyPair, await saveToken(userId), inSession(`session-of-${userId}`))
    return { keyPair, kid, session: `session-of-${userId}` }
  }

  it('keeps no tab’s save while the server is still answering, nor after it ends the session', async () => {
    const { keyPair, kid, session } = await keptHere('v1')
    const answer = later<{ error: null }>()
    auth.signOut = () => answer.promise
    const leaving = signOut('v1')
    // The key goes, and every tab hears of it, before the server answers.
    await new Promise<void>((resolve) => otherTab.onFence('v1', resolve))
    expect(await loadIdentity('v1')).toBeNull()
    // Another tab, taking a new token and still in the session, can't put it back meanwhile.
    await expect(
      otherTab.storeIdentity('v1', kid, keyPair, await otherTab.saveToken('v1'), inSession(session)),
    ).rejects.toEqual(refusal('signingOut'))
    answer.settle({ error: null })
    expect(await leaving).toBe(true)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
    await expect(
      otherTab.storeIdentity('v1', kid, keyPair, await otherTab.saveToken('v1'), inSession(session)),
    ).rejects.toEqual(refusal('signingOut'))
    expect(await loadIdentity('v1')).toBeNull()
  })

  it('lets new work keep the key again when the server says the session goes on', async () => {
    const { keyPair, kid, session } = await keptHere('v2')
    auth.signOut = async () => ({ error: { status: 403, message: 'no' } })
    expect(await signOut('v2')).toBe(false)
    await storeIdentity('v2', kid, keyPair, await saveToken('v2'), inSession(session))
    expect((await loadIdentity('v2'))?.kid).toBe(kid)
  })

  it('keeps saves stopped when the server can’t say whether the session ended', async () => {
    const { keyPair, kid, session } = await keptHere('v3')
    auth.signOut = async () => ({ error: { status: 503 } })
    expect(await signOut('v3')).toBe(false)
    auth.signOut = () => Promise.reject(new TypeError('Failed to fetch'))
    expect(await signOut('v3')).toBe(false)
    await expect(storeIdentity('v3', kid, keyPair, await saveToken('v3'), inSession(session))).rejects.toEqual(
      refusal('signingOut'),
    )
  })

  it('changes nothing here when the server can’t be reached to start with', async () => {
    const { kid } = await keptHere('v4')
    const token = await saveToken('v4')
    auth.sessionFails = true
    try {
      expect(await signOut('v4')).toBe(false)
    } finally {
      auth.sessionFails = false
    }
    expect((await loadIdentity('v4'))?.kid).toBe(kid)
    expect(await saveToken('v4')).toBe(token)
  })

  it('turns saves away with a reason that says what to do', () => {
    expect(new KeepRefused('unreachable').message).toMatch(/couldn’t be reached.*Try again/)
    expect(new KeepRefused('signingOut').message).toMatch(/Sign out, then sign in again/)
  })
})
