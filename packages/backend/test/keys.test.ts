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
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { api, components, internal } from '../convex/_generated/api'
import { MAX_PASSKEY_BACKUPS, MIN_MEMLIMIT, MIN_OPSLIMIT } from '../convex/keys'
import { sealed, setup, signIn, type T, installNetworks } from './setup'

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

/**
 * Asks for a challenge and opens it with the identity key, as a device holding it does. With
 * `first`, the challenge names the key, as on a first device before the account has one.
 */
async function proofFrom(as: As, identity: KeyPair, first = false) {
  const { sealed } = await as.mutation(api.keys.challenge, first ? { publicKey: toBase64Url(identity.publicKey) } : {})
  return toBase64Url(openSealedBox(fromBase64Url(sealed), identity))
}

/** The first device's whole setup: a challenge for its new key, and `keys.setup` with the proof. */
async function setUp(as: As, device: ReturnType<typeof firstDevice>) {
  return await as.mutation(api.keys.setup, { ...device.args, proof: await proofFrom(as, device.identity, true) })
}

/** A WebAuthn credential ID, as base64url. */
const credential = (n: number) => toBase64Url(new TextEncoder().encode(`credential-${n}`))

/** Registers a passkey for `userId` in Better Auth, as adding one in the browser does. */
async function registerPasskey(t: T, userId: string, credentialId: string) {
  await t.run(async (ctx) => {
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'passkey',
        data: {
          userId,
          credentialID: credentialId,
          publicKey: 'pk',
          counter: 0,
          deviceType: 'singleDevice',
          backedUp: false,
          createdAt: Date.now(),
        },
      },
    })
  })
}

/** The passkeys Better Auth has for `userId`. */
async function registeredPasskeys(t: T, userId: string) {
  return await t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: 'passkey',
      where: [{ field: 'userId', value: userId }],
      paginationOpts: { cursor: null, numItems: 100 },
    })) as { page: { credentialID: string }[] }
    return page.map((row) => row.credentialID)
  })
}

/** A 32-byte X25519 point of order 8: every shared secret with it is zero. */
const LOW_ORDER = toBase64Url(
  Uint8Array.from(
    '5f9c95bc a3508c24 b1d0b155 9c83ef5b 04445cc4 581c8e86 d8224edd d09f1157'
      .replaceAll(' ', '')
      .match(/../g)!
      .map((byte) => parseInt(byte, 16)),
  ),
)

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
    expect(await setUp(sam, device)).toEqual({ kid: device.kid })
    expect(await setUp(sam, device)).toEqual({ kid: device.kid })

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
    const device = firstDevice('sam', 'one password here')
    const { args } = device
    const proof = await proofFrom(sam, device.identity, true)
    await expect(
      sam.mutation(api.keys.setup, { ...args, proof, recovery: { nonce: 'x', ct: 'plain private key' } }),
    ).rejects.toThrow(/wrapped key/)
    const weak = { ...args, password: { ...args.password, params: { ...args.password.params, opslimit: 2 } } }
    await expect(sam.mutation(api.keys.setup, { ...weak, proof })).rejects.toThrow(/settings/)
    await sam.mutation(api.keys.setup, { ...args, proof })
    const other = firstDevice('sam', 'another password')
    await expect(sam.mutation(api.keys.setup, { ...other.args, proof })).rejects.toThrow(/already has/)
    await expect(sam.mutation(api.keys.challenge, { publicKey: other.args.publicKey })).rejects.toThrow(/already has/)
  })

  it('takes a first key only with proof that the device holds it', async () => {
    const t = setup()
    const sam = await fresh(t)
    const device = firstDevice('sam', 'correct horse battery')
    // No proof, a proof for another key, and a made-up proof are all refused, and leave no key.
    await expect(
      sam.mutation(api.keys.setup, { ...device.args, proof: toBase64Url(new Uint8Array(32)) }),
    ).rejects.toThrow(/expired/)
    const other = generateKeyPair()
    const otherProof = await proofFrom(sam, other, true)
    await expect(sam.mutation(api.keys.setup, { ...device.args, proof: otherProof })).rejects.toThrow(/expired/)
    expect((await sam.query(api.keys.identity, {})).state).toBe('none')
    await expect(sam.mutation(api.keys.challenge, {})).rejects.toThrow(/Set up/)
    await setUp(sam, device)
    expect((await sam.query(api.keys.identity, {})).state).toBe('ready')
  })

  it('refuses public keys nothing can be sealed to', async () => {
    const t = setup()
    const sam = await fresh(t)
    const device = firstDevice('sam', 'correct horse battery')
    const highBit = fromBase64Url(device.args.publicKey)
    highBit[31]! |= 0x80
    const prime = new Uint8Array(32).fill(0xff)
    prime[0] = 0xed
    prime[31] = 0x7f
    for (const publicKey of [
      LOW_ORDER,
      toBase64Url(new Uint8Array(32)),
      toBase64Url(Uint8Array.of(1, ...new Uint8Array(31))),
      toBase64Url(highBit),
      toBase64Url(prime),
    ]) {
      await expect(sam.mutation(api.keys.challenge, { publicKey })).rejects.toThrow(/valid public key/)
      await expect(sam.mutation(api.keys.setup, { ...device.args, publicKey, proof: 'x' })).rejects.toThrow(
        /valid public key/,
      )
    }
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
    await setUp(sam, device)
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

  it('never reuses a revision, even for a passkey backup removed and made again', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const wrap = () =>
      wrapIdentityKey(device.identity.privateKey, new Uint8Array(32).fill(9), {
        userId: 'sam',
        kid: device.kid,
        kind: 'passkey',
      })
    const prfSalt = toBase64Url(new Uint8Array(32).fill(1))
    const put = async (credentialId: string, expectedRevision: number) =>
      await sam.mutation(api.keys.putBackup, {
        kind: 'passkey',
        ...wrap(),
        credentialId,
        prfSalt,
        proof: await proofFrom(sam, device.identity),
        expectedRevision,
      })
    const credentialId = credential(1)
    await registerPasskey(t, 'sam', credentialId)
    const { revision: first } = await put(credentialId, 0)
    expect(first).toBe(2)
    await sam.mutation(api.keys.removePasskeyBackup, { credentialId, proof: await proofFrom(sam, device.identity) })
    // A device that still thinks it holds revision 2 can't write over the removal...
    await expect(put(credentialId, first)).rejects.toThrow(/another device/)
    const { revision: again } = await put(credentialId, 0)
    expect(again).toBeGreaterThan(first)
    // ...nor over the backup made again.
    await expect(put(credentialId, first)).rejects.toThrow(/another device/)
  })

  it('keeps the highest revision seen when a backup goes from an account without the counter', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const credentialId = credential(5)
    await registerPasskey(t, 'sam', credentialId)
    // A passkey backup at revision 7, written before the counter existed.
    await t.run(async (ctx) => {
      const member = (await ctx.db.query('members').first())!
      await ctx.db.patch(member._id, { backupRevision: undefined })
      await ctx.db.insert('keyBackups', {
        userId: 'sam',
        kid: device.kid,
        kind: 'passkey',
        nonce: 'n'.repeat(32),
        ct: 'c'.repeat(64),
        credentialId,
        prfSalt: toBase64Url(new Uint8Array(32)),
        revision: 7,
        createdAt: Date.now(),
      })
    })
    await sam.mutation(api.keys.removePasskeyBackup, { credentialId, proof: await proofFrom(sam, device.identity) })
    const wrap = wrapIdentityKey(device.identity.privateKey, new Uint8Array(32).fill(9), {
      userId: 'sam',
      kid: device.kid,
      kind: 'passkey',
    })
    const { revision } = await sam.mutation(api.keys.putBackup, {
      kind: 'passkey',
      ...wrap,
      credentialId,
      prfSalt: toBase64Url(new Uint8Array(32)),
      proof: await proofFrom(sam, device.identity),
      expectedRevision: 0,
    })
    expect(revision).toBe(8)
  })

  it('caps passkey backups and their PRF salts', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const wrap = wrapIdentityKey(device.identity.privateKey, new Uint8Array(32).fill(9), {
      userId: 'sam',
      kid: device.kid,
      kind: 'passkey',
    })
    const put = async (credentialId: string, prfSalt: string) =>
      await sam.mutation(api.keys.putBackup, {
        kind: 'passkey',
        ...wrap,
        credentialId,
        prfSalt,
        proof: await proofFrom(sam, device.identity),
        expectedRevision: 0,
      })
    const salt = toBase64Url(new Uint8Array(32).fill(1))
    await expect(put(credential(0), toBase64Url(new Uint8Array(1024)))).rejects.toThrow(/PRF salt/)
    await expect(put(credential(0), 'not base64url!')).rejects.toThrow(/PRF salt/)
    await expect(put('c'.repeat(600), salt)).rejects.toThrow(/PRF salt/)
    for (let i = 0; i < MAX_PASSKEY_BACKUPS; i++) {
      await registerPasskey(t, 'sam', credential(i))
      await put(credential(i), salt)
    }
    await registerPasskey(t, 'sam', credential(99))
    await expect(put(credential(99), salt)).rejects.toThrow(/at most 10 passkey/)
    expect((await sam.query(api.keys.identity, {})).backups).toHaveLength(2 + MAX_PASSKEY_BACKUPS)
  })

  it('makes a passkey backup only for a passkey on this account', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    await fresh(t, 'alex')
    const wrap = wrapIdentityKey(device.identity.privateKey, new Uint8Array(32).fill(9), {
      userId: 'sam',
      kid: device.kid,
      kind: 'passkey',
    })
    const put = async (credentialId: string) =>
      await sam.mutation(api.keys.putBackup, {
        kind: 'passkey',
        ...wrap,
        credentialId,
        prfSalt: toBase64Url(new Uint8Array(32).fill(1)),
        proof: await proofFrom(sam, device.identity),
        expectedRevision: 0,
      })
    // Not registered at all, or registered to someone else (another tab's account).
    await expect(put(credential(1))).rejects.toThrow(/isn’t on your account/)
    await registerPasskey(t, 'alex', credential(2))
    await expect(put(credential(2))).rejects.toThrow(/isn’t on your account/)
    await registerPasskey(t, 'sam', credential(3))
    await put(credential(3))
    expect((await sam.query(api.keys.identity, {})).backups.filter((b) => b.kind === 'passkey')).toHaveLength(1)
  })

  it('lists only the person’s own passkeys', async () => {
    const t = setup()
    const { sam } = await ready_(t)
    await fresh(t, 'alex')
    await registerPasskey(t, 'sam', credential(1))
    await registerPasskey(t, 'alex', credential(2))
    expect((await sam.query(api.keys.passkeys, {})).map((p) => p.credentialId)).toEqual([credential(1)])
  })

  it('removes a passkey and its backup together, and nobody else’s', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    await fresh(t, 'alex')
    const credentialId = credential(1)
    await registerPasskey(t, 'sam', credentialId)
    await registerPasskey(t, 'alex', credential(2))
    const wrap = wrapIdentityKey(device.identity.privateKey, new Uint8Array(32).fill(9), {
      userId: 'sam',
      kid: device.kid,
      kind: 'passkey',
    })
    await sam.mutation(api.keys.putBackup, {
      kind: 'passkey',
      ...wrap,
      credentialId,
      prfSalt: toBase64Url(new Uint8Array(32).fill(1)),
      proof: await proofFrom(sam, device.identity),
      expectedRevision: 0,
    })
    await sam.mutation(api.keys.removePasskey, { credentialId, proof: await proofFrom(sam, device.identity) })
    expect(await registeredPasskeys(t, 'sam')).toEqual([])
    expect((await sam.query(api.keys.identity, {})).backups.filter((b) => b.kind === 'passkey')).toEqual([])
    // Another person's credential, named here, isn't touched.
    await sam.mutation(api.keys.removePasskey, {
      credentialId: credential(2),
      proof: await proofFrom(sam, device.identity),
    })
    expect(await registeredPasskeys(t, 'alex')).toEqual([credential(2)])
    // Without a proof, nothing goes.
    await registerPasskey(t, 'sam', credential(3))
    await expect(
      sam.mutation(api.keys.removePasskey, { credentialId: credential(3), proof: 'p'.repeat(43) }),
    ).rejects.toThrow(/proof/)
    expect(await registeredPasskeys(t, 'sam')).toEqual([credential(3)])
  })

  it('keeps each person’s backups and challenges to themselves', async () => {
    const t = setup()
    const { sam, device } = await ready_(t)
    const alex = await fresh(t, 'alex')
    expect((await alex.query(api.keys.identity, {})).backups).toHaveLength(0)
    await expect(alex.mutation(api.keys.challenge, {})).rejects.toThrow(/Set up/)
    const samProof = await proofFrom(sam, device.identity)
    // Alex has no key, so nothing of Sam's counts as a proof for Alex.
    await expect(alex.mutation(api.keys.removePasskeyBackup, { credentialId: 'x', proof: samProof })).rejects.toThrow(
      /Set up/,
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

// Each test derives Argon2id keys at 64 MiB, which is slow while other suites run alongside.
describe('changing the password', { timeout: 30_000 }, () => {
  /** A set-up account with an email-and-password sign-in credential for `authPassword`. */
  async function withPassword(t: T, authPassword: string) {
    const sam = await fresh(t)
    const device = firstDevice('sam', 'old password!!')
    await setUp(sam, device)
    const hash = await hashPassword(authPassword)
    await t.run(async (ctx) => {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'account',
          data: {
            accountId: 'sam',
            providerId: 'credential',
            userId: 'sam',
            password: hash,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      })
    })
    return { sam, device }
  }

  async function signInHash(t: T) {
    return await t.run(async (ctx) => {
      const account = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'account',
        where: [{ field: 'userId', value: 'sam' }],
      })) as { password: string }
      return account.password
    })
  }

  function newWrap(device: ReturnType<typeof firstDevice>, password: string) {
    const params = newPasswordParams()
    const wrap = wrapIdentityKey(device.identity.privateKey, passwordKey(password, params), {
      userId: 'sam',
      kid: device.kid,
      kind: 'password',
    })
    return { ...wrap, params }
  }

  /** Whether `password` opens the stored password backup. */
  async function unlocks(sam: As, device: ReturnType<typeof firstDevice>, password: string) {
    const backup = (await sam.query(api.keys.identity, {})).backups.find((b) => b.kind === 'password')!
    try {
      unwrapIdentityKey(
        backup,
        passwordKey(password, backup.params!),
        { userId: 'sam', kid: device.kid, kind: 'password' },
        device.identity.publicKey,
      )
      return true
    } catch {
      return false
    }
  }

  it('changes the sign-in password and the backup together', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const result = await sam.action(api.account.changePassword, {
      currentAuthPassword: 'auth-old-password',
      newAuthPassword: 'auth-new-password',
      newWrap: newWrap(device, 'new password!!'),
      proof: await proofFrom(sam, device.identity),
      expectedRevision: 1,
    })
    expect(result).toEqual({ revision: 2 })
    expect(await verifyPassword({ hash: await signInHash(t), password: 'auth-new-password' })).toBe(true)
    expect(await unlocks(sam, device, 'new password!!')).toBe(true)
  })

  it('changes the password with the page’s session named', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const { sessionId } = (await sam.query(api.members.me, {}))!
    const result = await sam.action(api.account.changePassword, {
      currentAuthPassword: 'auth-old-password',
      newAuthPassword: 'auth-new-password',
      newWrap: newWrap(device, 'new password!!'),
      proof: await proofFrom(sam, device.identity),
      expectedRevision: 1,
      sessionId,
    })
    expect(result).toEqual({ revision: 2 })
    expect(await verifyPassword({ hash: await signInHash(t), password: 'auth-new-password' })).toBe(true)
  })

  it('checks the session again in the transactions that write, after the action’s own check', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const { sessionId } = (await sam.query(api.members.me, {}))!
    const before = await signInHash(t)
    const proof = await proofFrom(sam, device.identity)
    const wrap = { ...newWrap(device, 'new password!!'), expectedRevision: 1, sessionId }
    // The session ends while the action runs: between its check and the mutations it calls.
    expect(await t.mutation(internal.auth.endSessionByToken, { token: 'token-sam' })).toBe('ended')
    const changed = { data: { code: 'sessionChanged' } }
    await expect(
      sam.mutation(internal.keys.checkPasswordChange, { userId: 'sam', proof, ...wrap }),
    ).rejects.toMatchObject(changed)
    await expect(
      sam.mutation(internal.keys.commitPasswordChange, {
        userId: 'sam',
        previousHash: before,
        newHash: await hashPassword('auth-new-password'),
        ...wrap,
      }),
    ).rejects.toMatchObject(changed)
    // Another user's ID with this session is refused too.
    const bob = await fresh(t, 'bob')
    const { sessionId: bobSession } = (await bob.query(api.members.me, {}))!
    await expect(
      bob.mutation(internal.keys.checkPasswordChange, { userId: 'sam', proof, ...wrap, sessionId: bobSession }),
    ).rejects.toMatchObject(changed)
    expect(await signInHash(t)).toBe(before)
    // A refused check spends none of the account's password checks.
    expect(await t.run(async (ctx) => await ctx.db.query('rateLimits').collect())).toEqual([])
    const password = await t.run(
      async (ctx) =>
        await ctx.db
          .query('keyBackups')
          .withIndex('by_user', (q) => q.eq('userId', 'sam').eq('kind', 'password'))
          .collect(),
    )
    expect(password.map((row) => row.revision)).toEqual([1])
  })

  it('counts a password check in the transaction that checks the session', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const { sessionId } = (await sam.query(api.members.me, {}))!
    await sam.mutation(internal.keys.checkPasswordChange, {
      userId: 'sam',
      proof: await proofFrom(sam, device.identity),
      ...newWrap(device, 'new password!!'),
      expectedRevision: 1,
      sessionId,
    })
    expect(await t.run(async (ctx) => (await ctx.db.query('rateLimits').collect()).length)).toBe(1)
  })

  it('limits how often the current password can be checked', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const wrap = newWrap(device, 'new password!!')
    const attempt = async () =>
      await sam.action(api.account.changePassword, {
        currentAuthPassword: 'auth-wrong-password',
        newAuthPassword: 'auth-new-password',
        newWrap: wrap,
        proof: await proofFrom(sam, device.identity),
        expectedRevision: 1,
      })
    for (let i = 0; i < 5; i++) await expect(attempt()).rejects.toThrow(/current password is wrong/)
    await expect(attempt()).rejects.toThrow(/Too many password attempts/)
  })

  it('changes nothing on a wrong password, a stale revision, weak settings or a reused proof', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const before = await signInHash(t)
    // One wrap for every attempt: each is an Argon2id run.
    const wrap = newWrap(device, 'new password!!')
    const attempt = async (overrides: Record<string, unknown>) =>
      await sam.action(api.account.changePassword, {
        currentAuthPassword: 'auth-old-password',
        newAuthPassword: 'auth-new-password',
        newWrap: wrap,
        proof: await proofFrom(sam, device.identity),
        expectedRevision: 1,
        ...overrides,
      })
    await expect(attempt({ currentAuthPassword: 'not-the-password' })).rejects.toThrow(/current password is wrong/)
    await expect(attempt({ newAuthPassword: 'short' })).rejects.toThrow(/isn’t allowed/)
    await expect(attempt({ expectedRevision: 5 })).rejects.toThrow(/another device/)
    await expect(
      attempt({ newWrap: { ...wrap, params: { ...wrap.params, memlimit: MIN_MEMLIMIT - 1 } } }),
    ).rejects.toThrow(/settings/)
    await expect(attempt({ proof: toBase64Url(new Uint8Array(32)) })).rejects.toThrow(/expired/)
    expect(await signInHash(t)).toBe(before)
    const password = await t.run(
      async (ctx) =>
        await ctx.db
          .query('keyBackups')
          .withIndex('by_user', (q) => q.eq('userId', 'sam').eq('kind', 'password'))
          .collect(),
    )
    expect(password.map((row) => row.revision)).toEqual([1])
  })

  it('lets one of two racing changes win, leaving sign-in and unlock on the same password', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const change = async (n: number) =>
      await sam.action(api.account.changePassword, {
        currentAuthPassword: 'auth-old-password',
        newAuthPassword: `auth-new-password-${n}`,
        newWrap: newWrap(device, `new password ${n}!!`),
        proof: await proofFrom(sam, device.identity),
        expectedRevision: 1,
      })
    const outcomes = await Promise.allSettled([change(1), change(2)])
    const won = outcomes.findIndex((outcome) => outcome.status === 'fulfilled')
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const n = won + 1
    expect(await verifyPassword({ hash: await signInHash(t), password: `auth-new-password-${n}` })).toBe(true)
    expect(await unlocks(sam, device, `new password ${n}!!`)).toBe(true)
  })

  it('refuses a commit when the credential or the backup moved after the checks', async () => {
    const t = setup()
    const { sam, device } = await withPassword(t, 'auth-old-password')
    const previousHash = await signInHash(t)
    // Both devices passed their checks against the same credential and revision.
    const commit = async (n: number) =>
      await t.mutation(internal.keys.commitPasswordChange, {
        userId: 'sam',
        previousHash,
        newHash: await hashPassword(`auth-new-password-${n}`),
        ...newWrap(device, `new password ${n}!!`),
        expectedRevision: 1,
      })
    await commit(1)
    await expect(commit(2)).rejects.toThrow(/another device/)
    expect(await verifyPassword({ hash: await signInHash(t), password: 'auth-new-password-1' })).toBe(true)
    expect(await unlocks(sam, device, 'new password 1!!')).toBe(true)
    // A credential changed some other way (never by Better Auth's routes, which are off) is
    // also caught: the backup isn't written over a password the action didn't check.
    const current = (await sam.query(api.keys.identity, {})).backups.find((b) => b.kind === 'password')!
    await expect(
      t.mutation(internal.keys.commitPasswordChange, {
        userId: 'sam',
        previousHash,
        newHash: await hashPassword('auth-new-password-3'),
        ...newWrap(device, 'new password 3!!'),
        expectedRevision: current.revision,
      }),
    ).rejects.toThrow(/changed on another device/)
  })

  it('turns off Better Auth’s own routes that change the password or email', async () => {
    const t = setup()
    for (const path of [
      'change-password',
      'set-password',
      'reset-password',
      'request-password-reset',
      'change-email',
    ]) {
      const response = await t.fetch(`/api/auth/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://trioditis.test' },
        body: JSON.stringify({ currentPassword: 'a', newPassword: 'b' }),
      })
      expect(response.status).toBe(404)
    }
  })
})

describe('key writes bound to a session', () => {
  const sessionChanged = {
    data: { code: 'sessionChanged', message: 'This page’s session has changed. Reload the page.' },
  }

  async function rows(t: T, userId: string) {
    return await t.run(async (ctx) => ({
      member: await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', userId))
        .unique(),
      backups: await ctx.db
        .query('keyBackups')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
      challenges: await ctx.db
        .query('keyChallenges')
        .withIndex('by_user', (q) => q.eq('userId', userId))
        .collect(),
    }))
  }

  it('writes when the call runs as the page’s session, and when no session is named', async () => {
    const t = setup()
    const alice = await fresh(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    const device = firstDevice('alice', 'alice password!!')
    const { sealed } = await alice.mutation(api.keys.challenge, {
      publicKey: toBase64Url(device.identity.publicKey),
      sessionId,
    })
    const proof = toBase64Url(openSealedBox(fromBase64Url(sealed), device.identity))
    expect(await alice.mutation(api.keys.setup, { ...device.args, proof, sessionId })).toEqual({ kid: device.kid })

    const bob = await fresh(t, 'bob')
    const bobDevice = firstDevice('bob', 'bob password!!!!')
    expect(await setUp(bob, bobDevice)).toEqual({ kid: bobDevice.kid })
  })

  it('refuses, writing nothing, when the shared client has switched to another account', async () => {
    const t = setup()
    await installNetworks(t)
    const alice = await fresh(t, 'alice')
    const { sessionId: alicePage } = (await alice.query(api.members.me, {}))!
    // Bob signed in from another tab, so the page's calls now run as him.
    const bob = await fresh(t, 'bob')
    const device = firstDevice('alice', 'alice password!!')
    const publicKey = toBase64Url(device.identity.publicKey)
    const before = await rows(t, 'bob')

    await expect(bob.mutation(api.keys.challenge, { publicKey, sessionId: alicePage })).rejects.toMatchObject(
      sessionChanged,
    )
    await expect(
      bob.mutation(api.keys.setup, { ...device.args, proof: 'p'.repeat(43), sessionId: alicePage }),
    ).rejects.toMatchObject(sessionChanged)
    await expect(
      bob.mutation(api.keys.putBackup, {
        kind: 'recovery',
        nonce: 'n'.repeat(32),
        ct: 'c'.repeat(64),
        proof: 'p'.repeat(43),
        expectedRevision: 0,
        sessionId: alicePage,
      }),
    ).rejects.toMatchObject(sessionChanged)
    await expect(
      bob.mutation(api.keys.removePasskeyBackup, {
        credentialId: credential(1),
        proof: 'p'.repeat(43),
        sessionId: alicePage,
      }),
    ).rejects.toMatchObject(sessionChanged)
    await expect(
      bob.mutation(api.keys.removePasskey, {
        credentialId: credential(1),
        proof: 'p'.repeat(43),
        sessionId: alicePage,
      }),
    ).rejects.toMatchObject(sessionChanged)
    await expect(bob.query(api.keys.passkeys, { sessionId: alicePage })).rejects.toMatchObject(sessionChanged)
    await expect(
      bob.action(api.account.changePassword, {
        currentAuthPassword: 'a'.repeat(43),
        newAuthPassword: 'b'.repeat(43),
        newWrap: { nonce: 'n'.repeat(32), ct: 'c'.repeat(64), params: newPasswordParams() },
        proof: 'p'.repeat(43),
        expectedRevision: 1,
        sessionId: alicePage,
      }),
    ).rejects.toMatchObject(sessionChanged)

    await expect(bob.mutation(api.logins.start, { network: 'whatsapp', sessionId: alicePage })).rejects.toMatchObject(
      sessionChanged,
    )
    await expect(
      bob.mutation(api.labels.create, {
        labelKey: 'label-key-work-0001',
        sealed: sealed('work'),
        sessionId: alicePage,
      }),
    ).rejects.toMatchObject(sessionChanged)
    await expect(
      bob.mutation(api.preferences.set, { sidebarLayout: 'simple', sessionId: alicePage }),
    ).rejects.toMatchObject(sessionChanged)
    // Approving an agent from a switched consent page.
    await expect(
      bob.action(api.mcp.authorize, { requestId: 'request', approve: true, sessionId: alicePage }),
    ).rejects.toMatchObject(sessionChanged)
    // An admin's page switched to another admin.
    const admin = await signIn(t, 'admin', 'admin')
    await expect(
      admin.mutation(api.members.invite, { email: 'x@example.com', role: 'member', sessionId: alicePage }),
    ).rejects.toMatchObject(sessionChanged)

    expect(await rows(t, 'bob')).toEqual(before)
    expect((await rows(t, 'alice')).challenges).toEqual([])
    expect(await t.run(async (ctx) => await ctx.db.query('loginSessions').collect())).toEqual([])
    expect(await t.run(async (ctx) => await ctx.db.query('labels').collect())).toEqual([])
    expect(await t.run(async (ctx) => await ctx.db.query('preferences').collect())).toEqual([])
    expect(await t.run(async (ctx) => await ctx.db.query('invitations').collect())).toEqual([])
  })

  it('passes an agent approval with the page’s session on to the MCP component', async () => {
    const t = setup()
    const carol = await signIn(t, 'carol')
    const { sessionId } = (await carol.query(api.members.me, {}))!
    // No such request: the component's own answer, so its handler ran.
    await expect(carol.action(api.mcp.authorize, { requestId: 'none', approve: false, sessionId })).rejects.toThrow(
      /expired/,
    )
  })

  it('starts a network login with the page’s session named', async () => {
    const t = setup()
    await installNetworks(t)
    const carol = await signIn(t, 'carol')
    const { sessionId } = (await carol.query(api.members.me, {}))!
    const loginSessionId = await carol.mutation(api.logins.start, { network: 'whatsapp', sessionId })
    expect(await carol.query(api.logins.session, { loginSessionId })).toMatchObject({ state: 'pending' })
  })

  it('refuses a page whose session has ended', async () => {
    const t = setup()
    const alice = await fresh(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    expect(await t.mutation(internal.auth.endSessionByToken, { token: 'token-alice' })).toBe('ended')
    await expect(alice.mutation(api.keys.challenge, { publicKey: LOW_ORDER, sessionId })).rejects.toMatchObject(
      sessionChanged,
    )
  })
})
