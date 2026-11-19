import { generateKeyPair, keyId, passkeyPrfSalt, ready, SealError, toBase64Url } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { asSession, authClient } from '../src/lib/auth-client.ts'
import { sessionChanged } from '../src/lib/errors.ts'
import { holdPrf, openPasskeyBackup, passkeyBackup, takePrf } from '../src/lib/passkeys.ts'

beforeAll(ready)

const prf = (fill: number, credentialId = 'cred-1') => ({ credentialId, output: new Uint8Array(32).fill(fill) })

describe('the PRF output held from signing in', () => {
  it('goes only to the account it was given for, once', () => {
    holdPrf(prf(1), 'alice')
    expect(takePrf('alice')?.output).toEqual(new Uint8Array(32).fill(1))
    expect(takePrf('alice')).toBeNull()
  })

  it('is dropped, not handed over, when another account’s screen asks for it', () => {
    holdPrf(prf(1), 'alice')
    expect(takePrf('bob')).toBeNull()
    expect(takePrf('alice')).toBeNull()
  })
})

describe('a passkey backup', () => {
  it('opens with the same passkey’s output, and no other', async () => {
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    const made = await passkeyBackup('alice', kid, keyPair, prf(3))
    expect(made.kind).toBe('passkey')
    expect(made.credentialId).toBe('cred-1')
    // Made with the input signing in asks for, so one touch both signs in and unlocks.
    expect(made.prfSalt).toBe(toBase64Url(passkeyPrfSalt()))
    const backup = { ...made, kid, revision: 1 }
    const opened = await openPasskeyBackup(backup, prf(3), 'alice', keyPair.publicKey)
    expect(opened.privateKey).toEqual(keyPair.privateKey)
    await expect(openPasskeyBackup(backup, prf(4), 'alice', keyPair.publicKey)).rejects.toThrow(SealError)
    await expect(openPasskeyBackup(backup, prf(3), 'bob', keyPair.publicKey)).rejects.toThrow(SealError)
  })
})

describe('adding a passkey', () => {
  /** The session header each request carried, by path, with fetch answered here. */
  async function headersSent(run: (fetchImpl: typeof fetch) => Promise<unknown>) {
    const sent: [string, string | null][] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      // The app's own origin in a browser; nothing's there in Node, so any base does.
      const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers)
      sent.push([url.pathname.replace(/^\/api\/auth/, ''), headers.get('x-trioditis-session-id')])
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await run(fetchImpl)
    return sent
  }

  it('names the page’s session on both registration steps, and only while adding', async () => {
    const sent = await headersSent(async (customFetchImpl) => {
      await asSession('session-1', async () => {
        await authClient.$fetch('/passkey/generate-register-options', { method: 'GET', customFetchImpl })
        await authClient.$fetch('/passkey/verify-registration', { method: 'POST', body: {}, customFetchImpl })
        await authClient.$fetch('/passkey/list-user-passkeys', { method: 'GET', customFetchImpl })
      })
      await authClient.$fetch('/passkey/generate-register-options', { method: 'GET', customFetchImpl })
    })
    expect(sent).toEqual([
      ['/passkey/generate-register-options', 'session-1'],
      ['/passkey/verify-registration', 'session-1'],
      ['/passkey/list-user-passkeys', null],
      // After asSession: no header.
      ['/passkey/generate-register-options', null],
    ])
  })

  it('adds one at a time, so a second can’t lose the first’s header', async () => {
    let finish!: () => void
    const first = asSession('session-1', () => new Promise<void>((resolve) => (finish = resolve)))
    await expect(asSession('session-1', async () => undefined)).rejects.toThrow(/already being added/)
    finish()
    await first
    // Once it's done, the next may start.
    await expect(asSession('session-1', async () => 'ok')).resolves.toBe('ok')
  })

  it('treats Better Auth’s session refusal as the page’s session having changed', () => {
    expect(sessionChanged({ code: 'sessionChanged', message: 'This page’s session has changed.', status: 409 })).toBe(
      true,
    )
    expect(sessionChanged({ code: 'ERROR_CEREMONY_ABORTED' })).toBe(false)
  })
})
