import { generateKeyPair, keyId, ready } from '@trioditis/crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// The auth server, and this browser's cookie, shared by every tab. /end-session (the backend's
// own route) ends the session with the given token, whoever the cookie is, and never touches
// the cookie; Better Auth's getSession answers for the cookie's session.
const server = vi.hoisted(() => {
  const sessions = new Map<string, { id: string; userId: string }>()
  let n = 0
  const state = {
    sessions,
    cookie: null as string | null,
    reachable: true,
    /** Forced error answer for /end-session, as a 429 or 503. */
    status: null as number | null,
    /** Runs as each /end-session request goes, before the server acts on it. */
    onRequest: async () => {},
    /** The server acts on /end-session, but its answer never reaches the browser. */
    loseResponse: false,
    /** Runs on every session read. */
    onRead: () => {},
    ended: [] as string[],
    signIn(userId: string) {
      const token = `token-${++n}`
      sessions.set(token, { id: `session-${n}`, userId })
      state.cookie = token
      return { id: `session-${n}`, token }
    },
  }
  return state
})
vi.mock('../src/lib/auth-client.ts', () => ({
  authClient: {
    getSession: async () => {
      server.onRead()
      if (!server.reachable) throw new TypeError('Failed to fetch')
      const mine = server.cookie ? server.sessions.get(server.cookie) : undefined
      return {
        data: mine ? { user: { id: mine.userId }, session: { id: mine.id, token: server.cookie } } : null,
        error: null,
      }
    },
    $fetch: async (path: string, { body }: { body: { token: string } }) => {
      if (path !== '/end-session') throw new Error(`unexpected ${path}`)
      server.ended.push(body.token)
      await server.onRequest()
      if (!server.reachable) throw new TypeError('Failed to fetch')
      if (server.status) return { data: null, error: { status: server.status } }
      const result = server.sessions.delete(body.token) ? 'ended' : 'absent'
      if (server.loseResponse) throw new TypeError('Failed to fetch')
      return { data: { result }, error: null }
    },
    signOut: () => Promise.reject(new Error('signing out ends the session it noted, not the cookie’s')),
    revokeSession: () => Promise.reject(new Error('signing out ends the session by /end-session')),
  },
}))

const db = fakeIndexedDB()
const location = { assign: vi.fn() }
Object.assign(globalThis, { indexedDB: db, window: { isSecureContext: true, location } })
const keys = await import('../src/lib/keys.ts')
const { forgetIdentity, KeepRefused, loadIdentity, onFence, saveToken, storeIdentity } = keys
const { rememberSession, signOut } = await import('../src/lib/sign-out.ts')
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

  beforeEach(() => {
    Object.assign(server, { reachable: true, status: null, onRequest: async () => {}, loseResponse: false, ended: [] })
    db.failing = 0
  })

  /** Signs in, as the gate opens (noting the session's token), and keeps a key here. */
  async function keptHere(userId: string) {
    const session = server.signIn(userId)
    expect(await rememberSession(session.id)).toBe('noted')
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    await storeIdentity(userId, kid, keyPair, await saveToken(userId), inSession(session.id))
    return { keyPair, kid, session }
  }
  const saveIn = (tab: typeof keys, userId: string, kept: Awaited<ReturnType<typeof keptHere>>, session: string) =>
    tab.saveToken(userId).then((token) => tab.storeIdentity(userId, kept.kid, kept.keyPair, token, inSession(session)))
  const held = () => {
    const gate = later<void>()
    server.onRequest = () => gate.promise
    return gate
  }

  it('keeps no tab’s save while the server is still answering, nor after it ends the session', async () => {
    const kept = await keptHere('v1')
    const gate = held()
    const leaving = signOut('v1', kept.session.id)
    // The key goes, and every tab hears of it, before the request goes.
    await new Promise<void>((resolve) => otherTab.onFence('v1', resolve))
    expect(await loadIdentity('v1')).toBeNull()
    // Another tab, taking a new token and still in the session, can't put it back meanwhile.
    await expect(saveIn(otherTab, 'v1', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    gate.settle()
    expect(await leaving).toBeNull()
    expect(server.sessions.has(kept.session.token)).toBe(false)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
    await expect(saveIn(otherTab, 'v1', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    expect(await loadIdentity('v1')).toBeNull()
  })

  it('ends only the session it’s for, whoever signed in here as the request went', async () => {
    for (const who of ['v2', 'someone-else']) {
      const kept = await keptHere(`v2-${who}`)
      let again!: { id: string; token: string }
      server.onRequest = async () => void (again = server.signIn(who === 'v2' ? `v2-${who}` : who))
      expect(await signOut(`v2-${who}`, kept.session.id)).toBeNull()
      expect(server.sessions.has(kept.session.token)).toBe(false)
      // The session signed in meanwhile lives on, the cookie still holds it, and it may keep a key.
      expect(server.sessions.has(again.token)).toBe(true)
      expect(server.cookie).toBe(again.token)
    }
  })

  it('ends the session a stale screen is for, not the one another tab has signed in since', async () => {
    // "This account isn't on this server" for v7, while another tab signed in as someone else.
    const kept = await keptHere('v7')
    const other = server.signIn('someone-else')
    expect(await signOut('v7', kept.session.id)).toBeNull()
    expect(server.ended).toEqual([kept.session.token])
    expect(server.sessions.has(other.token)).toBe(true)
    expect(await loadIdentity('v7')).toBeNull()
  })

  it('says it can’t end a session it never learned the token of, while someone else is signed in', async () => {
    await keptHere('v16')
    server.signIn('someone-else')
    expect(await signOut('v16', 'a-session-never-seen-here')).toMatch(/couldn’t end your session/)
    expect(server.ended).toEqual([])
    await expect(
      storeIdentity('v16', 'k', generateKeyPair(), await saveToken('v16'), inSession('a-session-never-seen-here')),
    ).rejects.toEqual(refusal('signingOut'))
    // With no one signed in here, it still can't tell whether that session ended: it says so.
    server.cookie = null
    expect(await signOut('v16', 'a-session-never-seen-here')).toMatch(/couldn’t end your session/)
    expect(server.ended).toEqual([])
  })

  it('never lets one sign-out undo another’s fence, across two sessions', async () => {
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    // S1's sign-out, then S2's (signed in again since), then S1's tried again.
    await forgetIdentity('v3', { endingSession: 'S1' })
    await forgetIdentity('v3', { endingSession: 'S2' })
    await forgetIdentity('v3', { endingSession: 'S1' })
    // A save that took its token after all three, and checked S2 is still signed in.
    const token = await otherTab.saveToken('v3')
    const checked = later<string>()
    const save = otherTab.storeIdentity('v3', kid, keyPair, token, () => checked.promise)
    checked.settle('S2')
    await expect(save).rejects.toEqual(refusal('signingOut'))
    for (const session of ['S1', 'S2']) {
      await expect(storeIdentity('v3', kid, keyPair, await saveToken('v3'), inSession(session))).rejects.toEqual(
        refusal('signingOut'),
      )
    }
  })

  it('keeps saves for the session stopped whenever signing out didn’t go through, in every tab', async () => {
    const kept = await keptHere('v4')
    for (const fail of [() => (server.status = 429), () => (server.status = 503), () => (server.reachable = false)]) {
      Object.assign(server, { status: null, reachable: true })
      // Unreachable only once the request goes: it may or may not have arrived.
      server.onRequest = async () => void fail()
      expect(await signOut('v4', kept.session.id)).toMatch(/didn’t go through/)
      server.reachable = true
      await expect(saveIn(otherTab, 'v4', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    }
    expect(server.sessions.has(kept.session.token)).toBe(true)
    // Signing in again starts a session that keeps the key.
    await saveIn(keys, 'v4', kept, server.signIn('v4').id)
    expect((await loadIdentity('v4'))?.kid).toBe(kept.kid)
  })

  it('says it didn’t go through when the answer was lost, and goes through on trying again', async () => {
    const kept = await keptHere('v12')
    server.loseResponse = true
    expect(await signOut('v12', kept.session.id)).toMatch(/didn’t go through/)
    expect(server.sessions.has(kept.session.token)).toBe(false)
    server.loseResponse = false
    // Already ended: the server says so, and that counts.
    expect(await signOut('v12', kept.session.id)).toBeNull()
  })

  it('goes through when the session had already ended elsewhere', async () => {
    const kept = await keptHere('v5')
    server.sessions.delete(kept.session.token)
    expect(await signOut('v5', kept.session.id)).toBeNull()
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
  })

  it('asks nothing of the server but to end the session, and says when that can’t be done', async () => {
    const kept = await keptHere('v6')
    let reads = 0
    const read = server.onRead
    server.onRead = () => void reads++
    server.reachable = false
    try {
      expect(await signOut('v6', kept.session.id)).toMatch(/didn’t go through/)
    } finally {
      server.onRead = read
    }
    // No session read, which could set or clear the cookie: only the one request to end it.
    expect(reads).toBe(0)
    expect(server.ended).toEqual([kept.session.token])
    // Signing out stands here all the same: the key is gone, and none comes back for the session.
    expect(await loadIdentity('v6')).toBeNull()
    server.reachable = true
    await expect(saveIn(otherTab, 'v6', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
    expect(await signOut('v6', kept.session.id)).toBeNull()
  })

  it('notes only the session the page opened with', async () => {
    const opened = server.signIn('v17')
    server.signIn('someone-else')
    expect(await rememberSession(opened.id)).toBe('changed')
    server.reachable = false
    expect(await rememberSession(opened.id)).toBe('unknown')
  })

  it('tries forgetting again when storage fails once, so no save slips in', async () => {
    const kept = await keptHere('v8')
    db.failing = 1
    expect(await signOut('v8', kept.session.id)).toBeNull()
    expect(await loadIdentity('v8')).toBeNull()
    await expect(saveIn(otherTab, 'v8', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
  })

  it('doesn’t end the session when the sign-out couldn’t be recorded here, so no save lands after', async () => {
    const kept = await keptHere('v9')
    // A save in another tab has checked its session and is on its way to storage.
    const token = await otherTab.saveToken('v9')
    const checked = later<string>()
    const save = otherTab.storeIdentity('v9', kept.kid, kept.keyPair, token, () => checked.promise)
    db.failing = 3
    expect(await signOut('v9', kept.session.id)).toMatch(/couldn’t record the sign-out/)
    expect(server.ended).toEqual([])
    expect(server.sessions.has(kept.session.token)).toBe(true)
    checked.settle(kept.session.id)
    // It lands while still signed in, and a sign-out that works then forgets it.
    await save
    expect(await signOut('v9', kept.session.id)).toBeNull()
    expect(await loadIdentity('v9')).toBeNull()
  })

  it('forgets a key kept for want of backups, if they turned up and it was saved before the fence', async () => {
    // Signing out from "finish setting up": no key here as it starts, so it keeps whatever is.
    const kept = await keptHere('v13')
    const asked: string[] = []
    const failure = await signOut('v13', kept.session.id, {
      onlyKid: null,
      backedUpKid: async () => {
        // Asked only once the fence is in: a save from now on can't land.
        await expect(saveIn(otherTab, 'v13', kept, kept.session.id)).rejects.toEqual(refusal('signingOut'))
        asked.push('asked')
        return kept.kid
      },
    })
    expect(failure).toBeNull()
    expect(asked).toEqual(['asked'])
    expect(await loadIdentity('v13')).toBeNull()
  })

  it('keeps a key whose backups still don’t exist, and says so when that can’t be told', async () => {
    const first = await keptHere('v14')
    expect(await signOut('v14', first.session.id, { onlyKid: null, backedUpKid: async () => null })).toBeNull()
    expect((await loadIdentity('v14'))?.kid).toBe(first.kid)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in')
    const again = server.signIn('v14')
    await rememberSession(again.id)
    const unsure = () => Promise.reject(new Error('offline'))
    expect(await signOut('v14', again.id, { onlyKid: null, backedUpKid: unsure })).toBeNull()
    expect((await loadIdentity('v14'))?.kid).toBe(first.kid)
    expect(location.assign).toHaveBeenLastCalledWith('/sign-in?key=unconfirmed')
  })

  it('holds a save across a later fence, and refuses it when it gets to storage', async () => {
    const kept = await keptHere('v15')
    const token = await otherTab.saveToken('v15')
    const checked = later<string>()
    const save = otherTab.storeIdentity('v15', kept.kid, kept.keyPair, token, () => checked.promise)
    // The save waits on its session check while a sign-out of another session fences.
    await forgetIdentity('v15', { endingSession: 'elsewhere' })
    checked.settle(kept.session.id)
    await expect(save).rejects.toEqual(refusal('fenced'))
    expect(await loadIdentity('v15')).toBeNull()
  })

  it('turns saves away with a reason that says what to do', () => {
    expect(new KeepRefused('unreachable').message).toMatch(/couldn’t be reached.*Try again/)
    expect(new KeepRefused('signingOut').message).toMatch(/Sign out, then sign in again/)
  })
})
