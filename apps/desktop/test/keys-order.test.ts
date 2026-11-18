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
    /** How many of the next opens fail, as a browser's storage now and then does. */
    failing: 0,
    open() {
      const r: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void } = {}
      const fail = this.failing > 0
      if (fail) this.failing--
      later(() => {
        if (fail) {
          r.error = new Error('storage hiccup')
          return r.onerror?.()
        }
        r.result = { transaction, close: () => undefined }
        r.onsuccess?.()
      })
      return r
    },
  }
}

// The auth server, as lib/sign-out.ts sees it: who's signed in (the browser's cookie), and how
// ending a session goes.
type SignedIn = { user: { id: string }; session: { id: string; token: string } }
const auth = vi.hoisted(() => ({
  session: null as SignedIn | null,
  sessionFails: false,
  revoked: [] as string[],
  revoke: (_token: string): Promise<{ error: { status?: number } | null }> => Promise.resolve({ error: null }),
}))
vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: {
    getSession: async () => {
      if (auth.sessionFails) throw new TypeError('Failed to fetch')
      return { data: auth.session, error: null }
    },
    revokeSession: ({ token }: { token: string }) => {
      auth.revoked.push(token)
      return auth.revoke(token)
    },
    signOut: () => Promise.reject(new Error('signing out ends the session it noted, not the cookie’s')),
  },
}))

const db = fakeIndexedDB()
const location = { assign: vi.fn() }
Object.assign(globalThis, { indexedDB: db, window: { isSecureContext: true, location } })
const keys = await import('../src/lib/keys.ts')
const { forgetIdentity, KeepRefused, loadIdentity, onFence, saveToken, storeIdentity } = keys
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

  it('keeps nothing for a session being signed out of, in any tab, ever; a new session may', async () => {
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    await forgetIdentity('u8', { endingSession: 'S' })
    // Another tab took its token after the forget, and is still in session S as far as it knows.
    await expect(
      otherTab.storeIdentity('u8', kid, keyPair, await otherTab.saveToken('u8'), inSession('S')),
    ).rejects.toEqual(refusal('signingOut'))
    // A new session, signed in since, isn't the one being ended.
    await storeIdentity('u8', kid, keyPair, await saveToken('u8'), inSession('S2'))
    expect((await loadIdentity('u8'))?.kid).toBe(kid)
    // A forget with no session to note (another sign-out, say) doesn't lift the fence on S.
    await forgetIdentity('u8')
    await expect(storeIdentity('u8', kid, keyPair, await saveToken('u8'), inSession('S'))).rejects.toEqual(
      refusal('signingOut'),
    )
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

  const signIn = (userId: string, n = 1): SignedIn => {
    auth.session = { user: { id: userId }, session: { id: `${userId}-session-${n}`, token: `${userId}-token-${n}` } }
    return auth.session
  }
  async function keptHere(userId: string) {
    const { session } = signIn(userId)
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    await storeIdentity(userId, kid, keyPair, await saveToken(userId), inSession(session.id))
    return { keyPair, kid, session }
  }
  const saveIn = (tab: typeof keys, userId: string, kept: Awaited<ReturnType<typeof keptHere>>, session: string) =>
    tab.saveToken(userId).then((token) => tab.storeIdentity(userId, kept.kid, kept.keyPair, token, inSession(session)))

  it('keeps no tab’s save while the server is still answering, nor after it ends the session', async () => {
    const kept = await keptHere('v1')
    const answer = later<{ error: null }>()
    auth.revoke = () => answer.promise
    const leaving = signOut('v1')
    // The key goes, and every tab hears of it, before the server answers.
    await new Promise<void>((resolve) => otherTab.onFence('v1', resolve))
    expect(await loadIdentity('v1')).toBeNull()
    // Another tab, taking a new token and still in the session, can't put it back meanwhile.
    await expect(saveIn(otherTab, 'v1', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    answer.settle({ error: null })
    expect(await leaving).toBe(true)
    expect(auth.revoked.at(-1)).toBe(kept.session.token)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
    await expect(saveIn(otherTab, 'v1', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    expect(await loadIdentity('v1')).toBeNull()
  })

  it('ends the session it fenced, though another tab signed in again before the request went', async () => {
    const kept = await keptHere('v2')
    const answer = later<{ error: null }>()
    auth.revoke = () => answer.promise
    const leaving = signOut('v2')
    await new Promise<void>((resolve) => onFence('v2', resolve))
    // The cookie now holds a new session: it isn't the one ended, so it may keep the key.
    const again = signIn('v2', 2)
    answer.settle({ error: null })
    expect(await leaving).toBe(true)
    expect(auth.revoked.at(-1)).toBe(kept.session.token)
    await saveIn(otherTab, 'v2', kept, again.session.id)
    expect((await loadIdentity('v2'))?.kid).toBe(kept.kid)
  })

  it('keeps saves for the session stopped whenever signing out didn’t go through, in every tab', async () => {
    // Two tabs sign out at once: one is turned away (a 429, say), the other hasn't heard back.
    const kept = await keptHere('v3')
    const pending = later<{ error: null }>()
    const answers = [pending.promise, Promise.resolve({ error: { status: 429 } })]
    auth.revoke = () => answers.shift()!
    const first = signOut('v3')
    await new Promise<void>((resolve) => onFence('v3', resolve))
    expect(await signOut('v3')).toBe(false)
    await expect(saveIn(otherTab, 'v3', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    pending.settle({ error: null })
    expect(await first).toBe(true)
    // Timed out or failed on the server's side: still stopped.
    for (const revoke of [async () => ({ error: { status: 503 } }), () => Promise.reject(new Error('timed out'))]) {
      auth.revoke = revoke
      expect(await signOut('v3')).toBe(false)
      await expect(saveIn(keys, 'v3', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    }
    // Signing in again starts a session that keeps the key.
    await saveIn(keys, 'v3', kept, signIn('v3', 2).session.id)
    expect((await loadIdentity('v3'))?.kid).toBe(kept.kid)
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

  it('ends no session when they aren’t signed in here any more, and just forgets the key', async () => {
    await keptHere('v5')
    signIn('someone-else')
    const before = auth.revoked.length
    expect(await signOut('v5')).toBe(true)
    expect(auth.revoked.length).toBe(before)
    expect(await loadIdentity('v5')).toBeNull()
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
  })

  it('tries forgetting again when storage fails once, so no save slips in', async () => {
    const kept = await keptHere('v6')
    auth.revoke = async () => ({ error: null })
    db.failing = 1
    expect(await signOut('v6')).toBe(true)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
    expect(await loadIdentity('v6')).toBeNull()
    await expect(saveIn(otherTab, 'v6', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
  })

  it('says so on the sign-in page when the key couldn’t be forgotten', async () => {
    await keptHere('v7')
    db.failing = 3
    expect(await signOut('v7')).toBe(true)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in?key=unconfirmed')
  })

  it('turns saves away with a reason that says what to do', () => {
    expect(new KeepRefused('unreachable').message).toMatch(/couldn’t be reached.*Try again/)
    expect(new KeepRefused('signingOut').message).toMatch(/Sign out, then sign in again/)
  })
})
