import { beforeAll, describe, expect, it } from 'vitest'
import {
  MIN_PASSWORD_PARAMS,
  fromBase64Url,
  generateKeyPair,
  generateRecoveryKey,
  keyId,
  newPasswordParams,
  openSealedBox,
  passwordKey,
  ready,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
  type KeyPair,
} from '@trioditis/crypto'
import { api, internal } from '../convex/_generated/api'
import { MIN_MEMLIMIT, MIN_OPSLIMIT } from '../convex/keys'
import { setup, signIn, type T } from './setup'

beforeAll(ready)

/** What a first device does: make the key, wrap it twice, and hand over only the wraps. */
function firstDevice(userId: string, password: string, identity = generateKeyPair()) {
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

type As = Awaited<ReturnType<typeof signIn>>

/** Asks for a challenge and opens it with the identity key, as a device holding it does. */
async function proofFrom(as: As, identity: KeyPair) {
  const { sealed } = await as.mutation(api.keys.challenge, {})
  return toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
}

async function fresh(t: T, userId = 'sam') {
  return await signIn(t, userId, 'member', false)
}

describe('identity key setup', () => {
  it('keeps the server’s floor in step with the client’s', () => {
    expect({ opslimit: MIN_OPSLIMIT, memlimit: MIN_MEMLIMIT }).toEqual(MIN_PASSWORD_PARAMS)
  })

  it('sets up the key with both backups, and a new device unlocks with either', async () => {
    const t = setup()
    const sam = await fresh(t)
    expect((await sam.query(api.keys.identity, {})).state).toBe('none')
    const device = firstDevice('sam', 'correct horse battery')
    expect(await sam.mutation(api.keys.setup, device.args)).toEqual({ kid: device.kid })
    expect(await sam.mutation(api.keys.setup, device.args)).toEqual({ kid: device.kid })

    const { state, publicKey, kid, backups } = await sam.query(api.keys.identity, {})
    expect(state).toBe('ready')
    expect(backups.map((b) => [b.kind, b.revision]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ['password', 1],
      ['recovery', 1],
    ])
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
    expect(
      unwrapIdentityKey(recovery, device.recovery.bytes, { userId: 'sam', kid: kid!, kind: 'recovery' }, pk).privateKey,
    ).toEqual(device.identity.privateKey)
    expect(publicKey).toBe(toBase64Url(pk))
  })

  it('refuses a second, different identity key, malformed wraps and weak settings', async () => {
    const t = setup()
    const sam = await fresh(t)
    const { args } = firstDevice('sam', 'one password here')
    await expect(
      sam.mutation(api.keys.setup, { ...args, recovery: { nonce: 'x', ct: 'plain private key' } }),
    ).rejects.toThrow(/wrapped key/)
    const weak = { ...args, password: { ...args.password, params: { ...args.password.params, opslimit: 2 } } }
    await expect(sam.mutation(api.keys.setup, weak)).rejects.toThrow(/settings/)
    await sam.mutation(api.keys.setup, args)
    await expect(sam.mutation(api.keys.setup, firstDevice('sam', 'another password').args)).rejects.toThrow(
      /already has/,
    )
  })

  it('lets an account with a key but no backups add them, only with proof of the key', async () => {
    const t = setup()
    const sam = await fresh(t)
    const identity = generateKeyPair()
    await t.run(async (ctx) => {
      const member = (await ctx.db.query('members').first())!
      await ctx.db.patch(member._id, {
        identityPublicKey: toBase64Url(identity.publicKey),
        identityKid: keyId(identity.publicKey),
      })
    })
    expect((await sam.query(api.keys.identity, {})).state).toBe('needsBackup')
    const device = firstDevice('sam', 'correct horse battery', identity)
    await expect(sam.mutation(api.keys.setup, device.args)).rejects.toThrow(/Prove/)
    await expect(
      sam.mutation(api.keys.setup, { ...device.args, proof: toBase64Url(new Uint8Array(32)) }),
    ).rejects.toThrow(/expired/)
    await sam.mutation(api.keys.setup, { ...device.args, proof: await proofFrom(sam, identity) })
    expect((await sam.query(api.keys.identity, {})).state).toBe('ready')
  })
})

describe('replacing backups', () => {
  async function ready_(t: T) {
    const sam = await fresh(t)
    const device = firstDevice('sam', 'old password!!')
    await sam.mutation(api.keys.setup, device.args)
    return { sam, device }
  }

  it('needs a fresh proof, used once, and the revision it replaces', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const recovery = generateRecoveryKey()
    const wrap = wrapIdentityKey(device.identity.privateKey, recovery.bytes, {
      userId: 'sam',
      kid: device.kid,
      kind: 'recovery',
    })
    const proof = await proofFrom(sam, device.identity)
    await expect(
      sam.mutation(api.keys.putBackup, { kind: 'recovery', ...wrap, proof, expectedRevision: 0 }),
    ).rejects.toThrow(/another device/)
    expect(await sam.mutation(api.keys.putBackup, { kind: 'recovery', ...wrap, proof, expectedRevision: 1 })).toEqual({
      revision: 2,
    })
    // The same proof doesn't work twice.
    await expect(
      sam.mutation(api.keys.putBackup, { kind: 'recovery', ...wrap, proof, expectedRevision: 2 }),
    ).rejects.toThrow(/expired/)
    const { backups } = await sam.query(api.keys.identity, {})
    const stored = backups.find((b) => b.kind === 'recovery')!
    expect(stored.revision).toBe(2)
    expect(
      unwrapIdentityKey(
        stored,
        recovery.bytes,
        { userId: 'sam', kid: device.kid, kind: 'recovery' },
        device.identity.publicKey,
      ).privateKey,
    ).toEqual(device.identity.privateKey)
  })

  it('checks a password change: proof, revision, and settings no weaker than before', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const params = newPasswordParams()
    const wrap = wrapIdentityKey(device.identity.privateKey, passwordKey('new password!!', params), {
      userId: 'sam',
      kid: device.kid,
      kind: 'password',
    })
    const check = (proof: string, overrides: Record<string, unknown> = {}) =>
      t.mutation(internal.keys.checkPasswordChange, {
        userId: 'sam',
        proof,
        ...wrap,
        params,
        expectedRevision: 1,
        ...overrides,
      })
    await expect(check(await proofFrom(sam, device.identity), { expectedRevision: 5 })).rejects.toThrow(
      /another device/,
    )
    await expect(
      check(await proofFrom(sam, device.identity), { params: { ...params, memlimit: MIN_MEMLIMIT - 1 } }),
    ).rejects.toThrow(/settings/)
    await check(await proofFrom(sam, device.identity))
    expect(
      await t.mutation(internal.keys.storePasswordWrap, { userId: 'sam', ...wrap, params, expectedRevision: 1 }),
    ).toEqual({ revision: 2 })
    const password = (await sam.query(api.keys.identity, {})).backups.find((b) => b.kind === 'password')!
    expect(() =>
      unwrapIdentityKey(
        password,
        passwordKey('old password!!', password.params!),
        { userId: 'sam', kid: device.kid, kind: 'password' },
        device.identity.publicKey,
      ),
    ).toThrow()
  })

  it('keeps each person’s backups and challenges to themselves', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const alex = await fresh(t, 'alex')
    expect((await alex.query(api.keys.identity, {})).backups).toHaveLength(0)
    await expect(alex.mutation(api.keys.challenge, {})).rejects.toThrow(/Set up/)
    const samProof = await proofFrom(sam, device.identity)
    await expect(alex.mutation(api.keys.removePasskeyBackup, { credentialId: 'x', proof: samProof })).rejects.toThrow(
      /expired/,
    )
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
  })
})
