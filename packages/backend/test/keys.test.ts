import { beforeAll, describe, expect, it } from 'vitest'
import {
  generateKeyPair,
  generateRecoveryKey,
  keyId,
  newPasswordParams,
  passwordKey,
  ready,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
} from '@trioditis/crypto'
import { api } from '../convex/_generated/api'
import { setup, signIn } from './setup'

beforeAll(ready)

/** What a first device does: make the key, wrap it twice, and hand over only the wraps. */
function firstDevice(userId: string, password: string) {
  const identity = generateKeyPair()
  const kid = keyId(identity.publicKey)
  const params = newPasswordParams()
  const recovery = generateRecoveryKey()
  const passwordWrap = wrapIdentityKey(identity.privateKey, passwordKey(password, params), {
    userId,
    kid,
    kind: 'password',
  })
  const recoveryWrap = wrapIdentityKey(identity.privateKey, recovery.bytes, { userId, kid, kind: 'recovery' })
  return {
    identity,
    kid,
    recovery,
    args: { publicKey: toBase64Url(identity.publicKey), password: { ...passwordWrap, params }, recovery: recoveryWrap },
  }
}

describe('identity key setup and backups', () => {
  it('sets up the key with both backups, and a new device unlocks with either', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    const device = firstDevice('sam', 'correct horse battery')
    expect(await sam.mutation(api.keys.setup, device.args)).toEqual({ kid: device.kid })
    // Repeating the same setup is harmless.
    expect(await sam.mutation(api.keys.setup, device.args)).toEqual({ kid: device.kid })

    const { publicKey, kid, backups } = await sam.query(api.keys.identity, {})
    expect(kid).toBe(device.kid)
    expect(backups.map((b) => b.kind).sort()).toEqual(['password', 'recovery'])
    const pk = device.identity.publicKey
    const password = backups.find((b) => b.kind === 'password')!
    const fromPassword = unwrapIdentityKey(
      password,
      passwordKey('correct horse battery', password.params!),
      { userId: 'sam', kid: kid!, kind: 'password' },
      pk,
    )
    expect(fromPassword.privateKey).toEqual(device.identity.privateKey)
    const recovery = backups.find((b) => b.kind === 'recovery')!
    const fromRecovery = unwrapIdentityKey(
      recovery,
      device.recovery.bytes,
      { userId: 'sam', kid: kid!, kind: 'recovery' },
      pk,
    )
    expect(fromRecovery.privateKey).toEqual(device.identity.privateKey)
    expect(publicKey).toBe(toBase64Url(pk))
  })

  it('refuses a second, different identity key', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    await sam.mutation(api.keys.setup, firstDevice('sam', 'one password here').args)
    await expect(sam.mutation(api.keys.setup, firstDevice('sam', 'another password').args)).rejects.toThrow(
      /already has/,
    )
  })

  it('refuses malformed wraps and weak password settings', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    const { args } = firstDevice('sam', 'correct horse battery')
    await expect(
      sam.mutation(api.keys.setup, { ...args, recovery: { nonce: 'x', ct: 'plain private key' } }),
    ).rejects.toThrow(/wrapped key/)
    const weak = { ...args, password: { ...args.password, params: { ...args.password.params, memlimit: 1024 } } }
    await expect(sam.mutation(api.keys.setup, weak)).rejects.toThrow(/settings/)
  })

  it('replaces a backup when the password changes', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    const device = firstDevice('sam', 'old password!!')
    await sam.mutation(api.keys.setup, device.args)
    const params = newPasswordParams()
    const wrap = wrapIdentityKey(device.identity.privateKey, passwordKey('new password!!', params), {
      userId: 'sam',
      kid: device.kid,
      kind: 'password',
    })
    await sam.mutation(api.keys.putBackup, { kind: 'password', ...wrap, params })
    const { backups } = await sam.query(api.keys.identity, {})
    expect(backups.filter((b) => b.kind === 'password')).toHaveLength(1)
    const password = backups.find((b) => b.kind === 'password')!
    expect(() =>
      unwrapIdentityKey(
        password,
        passwordKey('old password!!', password.params!),
        { userId: 'sam', kid: device.kid, kind: 'password' },
        device.identity.publicKey,
      ),
    ).toThrow()
  })

  it('keeps each person’s backups to themselves', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    const alex = await signIn(t, 'alex', 'member', false)
    await sam.mutation(api.keys.setup, firstDevice('sam', 'sam’s password').args)
    expect((await alex.query(api.keys.identity, {})).backups).toHaveLength(0)
    await expect(alex.mutation(api.keys.putBackup, { kind: 'recovery', nonce: 'x', ct: 'y' })).rejects.toThrow(/Set up/)
  })
})

describe('preferences', () => {
  it('defaults to the simple sidebar and remembers a change, per person', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam')
    const alex = await signIn(t, 'alex')
    expect(await sam.query(api.preferences.get, {})).toEqual({ sidebarLayout: 'simple' })
    await sam.mutation(api.preferences.set, { sidebarLayout: 'focused' })
    expect(await sam.query(api.preferences.get, {})).toEqual({ sidebarLayout: 'focused' })
    expect(await alex.query(api.preferences.get, {})).toEqual({ sidebarLayout: 'simple' })
    await sam.mutation(api.preferences.set, {})
    expect(await sam.query(api.preferences.get, {})).toEqual({ sidebarLayout: 'focused' })
  })
})
