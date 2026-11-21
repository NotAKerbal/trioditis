import {
  fromBase64Url,
  generateKeyPair,
  generateRecoveryKey,
  keyId,
  newPasswordParams,
  openSealedBox,
  passwordKey,
  ready,
  seal,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
} from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { ResetRefused, resetPassword, type ResetInfo, type ResetServer } from '../src/features/auth/password-reset.ts'

beforeAll(ready)

const derive = async (password: string, email: string) => `auth:${email}:${password}`

/** A server for an account whose key has a recovery backup, recording what the reset sent. */
function account() {
  const identity = generateKeyPair()
  const kid = keyId(identity.publicKey)
  const recovery = generateRecoveryKey()
  const userId = 'u1'
  const info: ResetInfo = {
    userId,
    email: 'sam@x.test',
    key: {
      kid,
      publicKey: toBase64Url(identity.publicKey),
      recovery: wrapIdentityKey(identity.privateKey, recovery.bytes, { userId, kid, kind: 'recovery' }),
      passwordParams: { ...newPasswordParams(), opslimit: 4 },
    },
  }
  // A sealed box to the account's key, as keys.challenge makes one: the content key of an envelope.
  const challenge = seal(new Uint8Array([1]), [{ publicKey: identity.publicKey }], {
    kind: 'message',
    ownerUserId: userId,
    objectId: 'challenge',
  }).keys[0]!.sk
  const sent: Parameters<ResetServer['reset']>[0][] = []
  const server: ResetServer = {
    info: async () => info,
    challenge: async () => ({ sealed: challenge }),
    reset: async (args) => {
      sent.push(args)
      return null
    },
  }
  return { identity, kid, recovery, info, server, sent, challenge }
}

describe('resetting a forgotten password', { timeout: 30_000 }, () => {
  it('re-wraps the key with the new password and proves it, with the recovery key', async () => {
    const a = account()
    const email = await resetPassword(
      a.server,
      'token',
      { recoveryKey: a.recovery.text, newPassword: 'new password!!' },
      derive,
    )
    expect(email).toBe('sam@x.test')
    const [args] = a.sent
    expect(args).toMatchObject({ token: 'token', newAuthPassword: 'auth:sam@x.test:new password!!' })
    // Never weaker than the backup it replaces.
    expect(args!.newWrap!.params.opslimit).toBe(4)
    const opened = unwrapIdentityKey(
      args!.newWrap!,
      passwordKey('new password!!', args!.newWrap!.params),
      { userId: 'u1', kid: a.kid, kind: 'password' },
      a.identity.publicKey,
    )
    expect(opened.privateKey).toEqual(a.identity.privateKey)
    expect(args!.proof).toBe(toBase64Url(openSealedBox(fromBase64Url(a.challenge), a.identity)))
  })

  it('sends nothing for a recovery key that isn’t this account’s, or isn’t one at all', async () => {
    const a = account()
    await expect(
      resetPassword(a.server, 't', { recoveryKey: generateRecoveryKey().text, newPassword: 'new password!!' }, derive),
    ).rejects.toThrow(ResetRefused)
    await expect(
      resetPassword(a.server, 't', { recoveryKey: 'not a key', newPassword: 'new password!!' }, derive),
    ).rejects.toThrow(ResetRefused)
    expect(a.sent).toEqual([])
  })

  it('says so for a link that no longer works, and for a key with no recovery backup', async () => {
    const a = account()
    await expect(
      resetPassword(
        { ...a.server, info: async () => null },
        't',
        { recoveryKey: '', newPassword: 'x'.repeat(12) },
        derive,
      ),
    ).rejects.toThrow(/expired or was already used/)
    const noRecovery = { ...a.info, key: { ...a.info.key!, recovery: null } }
    await expect(
      resetPassword(
        { ...a.server, info: async () => noRecovery },
        't',
        { recoveryKey: '', newPassword: 'x'.repeat(12) },
        derive,
      ),
    ).rejects.toThrow(/no recovery key backup/)
    expect(a.sent).toEqual([])
  })

  it('resets an account with no key yet with the new password alone', async () => {
    const a = account()
    const server = { ...a.server, info: async () => ({ ...a.info, key: null }) }
    await resetPassword(server, 't', { recoveryKey: '', newPassword: 'new password!!' }, derive)
    expect(a.sent).toEqual([{ token: 't', newAuthPassword: 'auth:sam@x.test:new password!!' }])
  })
})
