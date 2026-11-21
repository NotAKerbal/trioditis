import { beforeAll, describe, expect, it } from 'vitest'
import {
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
} from '@trioditis/crypto'
import { hashPassword, verifyPassword } from 'better-auth/crypto'
import { api, components } from '../convex/_generated/api'
import { setup, signIn, type T } from './setup'

beforeAll(ready)

/** Sam: a Better Auth user with a password credential, a member with a key set up and both backups. */
async function sam(t: T, { withKey = true } = {}) {
  const userId = await t.run(async (ctx) => {
    const now = Date.now()
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: { model: 'user', data: { name: 'Sam', email: 'sam@x.test', emailVerified: false, createdAt: now, updatedAt: now } },
    })) as { _id: string }
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: user._id,
          providerId: 'credential',
          userId: user._id,
          password: await hashPassword('old auth password'),
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    return user._id
  })
  const as = await signIn(t, userId, 'member', false)
  const identity = generateKeyPair()
  const kid = keyId(identity.publicKey)
  const recovery = generateRecoveryKey()
  if (withKey) {
    const params = newPasswordParams()
    const password = wrapIdentityKey(identity.privateKey, passwordKey('old password!!', params), {
      userId,
      kid,
      kind: 'password',
    })
    const recoveryWrap = wrapIdentityKey(identity.privateKey, recovery.bytes, { userId, kid, kind: 'recovery' })
    const publicKey = toBase64Url(identity.publicKey)
    const { sealed } = await as.mutation(api.keys.challenge, { publicKey })
    await as.mutation(api.keys.setup, {
      publicKey,
      password: { ...password, params },
      recovery: recoveryWrap,
      proof: toBase64Url(openSealedBox(fromBase64Url(sealed), identity)),
    })
  }
  return { userId, as, identity, kid, recovery }
}

async function credentialHash(t: T, userId: string) {
  return await t.run(async (ctx) => {
    const account = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'account',
      where: [{ field: 'userId', value: userId }],
    })) as { password: string }
    return account.password
  })
}

/** What the reset page does with the link's token, the recovery key and a new password. */
async function resetWith(t: T, token: string, recoveryBytes: Uint8Array, newPassword: string) {
  const info = (await t.query(api.account.resetInfo, { token }))!
  const key = info.key!
  const context = { userId: info.userId, kid: key.kid }
  const keyPair = unwrapIdentityKey(
    key.recovery!,
    recoveryBytes,
    { ...context, kind: 'recovery' },
    fromBase64Url(key.publicKey),
  )
  const params = newPasswordParams()
  const wrap = wrapIdentityKey(keyPair.privateKey, passwordKey(newPassword, params), {
    ...context,
    kind: 'password',
  })
  const { sealed } = await t.mutation(api.account.resetChallenge, { token })
  return await t.action(api.account.resetPassword, {
    token,
    newAuthPassword: `auth:${newPassword}`,
    newWrap: { ...wrap, params },
    proof: toBase64Url(openSealedBox(fromBase64Url(sealed), keyPair)),
  })
}

describe('resetting a forgotten password', { timeout: 60_000 }, () => {
  it('sets the new sign-in password and re-wraps the key with it, together, and ends every session', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const s = await sam(t)
    const { token } = await admin.mutation(api.members.issuePasswordReset, { userId: s.userId })

    const info = await t.query(api.account.resetInfo, { token })
    expect(info).toMatchObject({ userId: s.userId, email: 'sam@x.test', key: { kid: s.kid } })

    await resetWith(t, token, s.recovery.bytes, 'new password!!')

    expect(await verifyPassword({ hash: await credentialHash(t, s.userId), password: 'auth:new password!!' })).toBe(true)
    const backup = (
      await t.run(async (ctx) => await ctx.db.query('keyBackups').collect())
    ).find((row) => row.userId === s.userId && row.kind === 'password')!
    const opened = unwrapIdentityKey(
      backup,
      passwordKey('new password!!', backup.params!),
      { userId: s.userId, kid: s.kid, kind: 'password' },
      s.identity.publicKey,
    )
    expect(opened.privateKey).toEqual(s.identity.privateKey)
    // Signed out everywhere, and the link is used up.
    expect(await s.as.query(api.members.me, {})).toBeNull()
    expect(await t.query(api.account.resetInfo, { token })).toBeNull()
    await expect(t.mutation(api.account.resetChallenge, { token })).rejects.toThrow(/expired or was already used/)
  })

  it('changes nothing without proof of the key, which only the recovery key gives', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const s = await sam(t)
    const before = await credentialHash(t, s.userId)
    const { token } = await admin.mutation(api.members.issuePasswordReset, { userId: s.userId })
    // A different recovery key doesn't open the key.
    await expect(resetWith(t, token, generateRecoveryKey().bytes, 'new password!!')).rejects.toThrow()
    const params = newPasswordParams()
    const forged = wrapIdentityKey(generateKeyPair().privateKey, passwordKey('new password!!', params), {
      userId: s.userId,
      kid: s.kid,
      kind: 'password',
    })
    await expect(
      t.action(api.account.resetPassword, {
        token,
        newAuthPassword: 'auth:new password!!',
        newWrap: { ...forged, params },
        proof: toBase64Url(new Uint8Array(32)),
      }),
    ).rejects.toThrow(/expired or was already used/)
    await expect(
      t.action(api.account.resetPassword, { token, newAuthPassword: 'auth:new password!!' }),
    ).rejects.toThrow(/recovery key/)
    expect(await credentialHash(t, s.userId)).toBe(before)
    // The link still works for the real recovery key.
    await resetWith(t, token, s.recovery.bytes, 'new password!!')
  })

  it('resets an account that has no key yet with the link alone', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const s = await sam(t, { withKey: false })
    const { token } = await admin.mutation(api.members.issuePasswordReset, { userId: s.userId })
    expect((await t.query(api.account.resetInfo, { token }))?.key).toBeNull()
    await t.action(api.account.resetPassword, { token, newAuthPassword: 'auth:new password!!' })
    expect(await verifyPassword({ hash: await credentialHash(t, s.userId), password: 'auth:new password!!' })).toBe(true)
  })

  it('is issued only by an admin, for someone else, and works only until it expires or a newer one replaces it', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const s = await sam(t)
    await expect(s.as.mutation(api.members.issuePasswordReset, { userId: s.userId })).rejects.toThrow(/admin/)
    await expect(admin.mutation(api.members.issuePasswordReset, { userId: 'admin' })).rejects.toThrow(/your own/)
    const first = await admin.mutation(api.members.issuePasswordReset, { userId: s.userId })
    const second = await admin.mutation(api.members.issuePasswordReset, { userId: s.userId })
    expect(await t.query(api.account.resetInfo, { token: first.token })).toBeNull()
    expect(await t.query(api.account.resetInfo, { token: second.token })).not.toBeNull()
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('passwordResets').collect()) await ctx.db.patch(row._id, { expiresAt: 1 })
    })
    expect(await t.query(api.account.resetInfo, { token: second.token })).toBeNull()
    await expect(t.mutation(api.account.resetChallenge, { token: second.token })).rejects.toThrow(/expired/)
  })
})
