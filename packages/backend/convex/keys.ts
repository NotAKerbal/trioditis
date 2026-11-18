import { ConvexError, v } from 'convex/values'
import { components } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'
import { audit } from './lib/audit'
import { decode, decodedLength, encode, isPublicKey, keyIdOf } from './lib/envelope'
import { sha256Hex } from './lib/hash'
import { sealBox } from './lib/seal'

/**
 * The bridge key: clients seal outbound sends and login input to it. See
 * docs/architecture/bridge-protocol.md, Bridge key.
 */
export const bridge = query({
  args: {},
  returns: v.union(v.null(), v.object({ publicKey: v.string() })),
  handler: async (ctx) => {
    await requireMember(ctx)
    const publicKey = process.env.BRIDGE_PUBLIC_KEY
    return publicKey ? { publicKey } : null
  },
})

// Identity key setup and backups. The identity private key never reaches the server
// unwrapped: the client wraps it (packages/crypto `wrapIdentityKey`) with a key derived from
// the person's password, with their recovery key, and later with a passkey, and stores only
// those wraps. Setting up the key, and changing a backup, needs proof that the device holds
// the private key (a challenge only it can open): so the first key is one a device can really
// use, and a stolen session can't replace someone's backups and lock them out. A change also
// names the revision it replaces, so a stale device can't undo a newer one. See
// docs/architecture/client-api.md, Keys.

/**
 * The weakest password settings a backup may use: three passes over 64 MiB. Keep in step with
 * `MIN_PASSWORD_PARAMS` in packages/crypto (a test checks).
 */
export const MIN_OPSLIMIT = 3
export const MIN_MEMLIMIT = 64 * 1024 * 1024
const MAX_OPSLIMIT = 10
const MAX_MEMLIMIT = 1024 * 1024 * 1024
const CHALLENGE_TTL_MS = 5 * 60 * 1000
/** Passkey backups a person may have, so their backups always fit in one small read. */
export const MAX_PASSKEY_BACKUPS = 10
/** A passkey backup's PRF salt: 32 bytes, as WebAuthn's PRF extension takes them. */
const PRF_SALT_BYTES = 32
/** The longest credential ID kept, in base64url characters. */
const MAX_CREDENTIAL_ID_LENGTH = 512

const backupKind = v.union(v.literal('password'), v.literal('recovery'), v.literal('passkey'))
const passwordParams = v.object({
  alg: v.literal('argon2id13'),
  salt: v.string(),
  opslimit: v.number(),
  memlimit: v.number(),
})
const wrapped = v.object({ nonce: v.string(), ct: v.string() })

type Params = { salt: string; opslimit: number; memlimit: number }

/** A wrapped 32-byte X25519 private key: a 24-byte nonce, and 32 bytes plus a 16-byte tag. */
function checkWrapped({ nonce, ct }: { nonce: string; ct: string }) {
  if (decodedLength(nonce) !== 24 || decodedLength(ct) !== 48) throw new ConvexError('That isn’t a wrapped key.')
}

/** At least the floor, never weaker than the backup it replaces, and at most what a browser can afford. */
function checkParams(params: Params, replacing?: Params) {
  const sane =
    decodedLength(params.salt) === 16 &&
    Number.isInteger(params.opslimit) &&
    Number.isInteger(params.memlimit) &&
    params.opslimit >= MIN_OPSLIMIT &&
    params.opslimit <= MAX_OPSLIMIT &&
    params.memlimit >= MIN_MEMLIMIT &&
    params.memlimit <= MAX_MEMLIMIT &&
    (!replacing || (params.opslimit >= replacing.opslimit && params.memlimit >= replacing.memlimit))
  if (!sane) throw new ConvexError('Those password settings aren’t allowed.')
}

export async function backupsOf(ctx: QueryCtx, userId: string) {
  return await ctx.db
    .query('keyBackups')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(50)
}

/** `none`: no identity key yet. `needsBackup`: a key, but not both a password and a recovery backup. `ready`: both. */
export function keyState(member: Doc<'members'>, backups: Doc<'keyBackups'>[]) {
  if (!member.identityPublicKey) return 'none' as const
  const current = backups.filter((row) => row.kid === member.identityKid)
  const has = (kind: string) => current.some((row) => row.kind === kind)
  return has('password') && has('recovery') ? ('ready' as const) : ('needsBackup' as const)
}

/**
 * Uses up a challenge the device opened, sealed to `publicKey`. Each works once, within five
 * minutes, and only for the key it was sealed to.
 */
async function consumeProof(ctx: MutationCtx, userId: string, proof: string, publicKey: string) {
  const hash = await sha256Hex(proof)
  const now = Date.now()
  const rows = await ctx.db
    .query('keyChallenges')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(20)
  const match = rows.find((row) => row.hash === hash && row.publicKey === publicKey && row.expiresAt > now)
  for (const row of rows) if (row === match || row.expiresAt <= now) await ctx.db.delete(row._id)
  if (!match) throw new ConvexError('That proof of your key has expired or was already used. Try again.')
}

/** The proof for a change to the person's existing key. */
async function consumeKeyProof(ctx: MutationCtx, member: Doc<'members'>, proof: string) {
  if (!member.identityPublicKey) throw new ConvexError('Set up this account’s key first.')
  await consumeProof(ctx, member.userId, proof, member.identityPublicKey)
}

/**
 * The next backup revision: above every revision the person's backups have had, including
 * removed ones, so a device holding an old revision can never match a newer backup.
 */
async function nextRevision(ctx: MutationCtx, member: Doc<'members'>, backups: Doc<'keyBackups'>[]) {
  const next = backups.reduce((n, row) => Math.max(n, row.revision), member.backupRevision ?? 0) + 1
  await ctx.db.patch(member._id, { backupRevision: next })
  return next
}

const backupRow = v.object({
  _id: v.id('keyBackups'),
  kid: v.string(),
  kind: backupKind,
  nonce: v.string(),
  ct: v.string(),
  params: v.optional(passwordParams),
  credentialId: v.optional(v.string()),
  prfSalt: v.optional(v.string()),
  revision: v.number(),
  createdAt: v.number(),
})

/**
 * The signed-in person's identity public key, its backups, and what to do: `none` (set the key
 * up on this device), `needsBackup` (add the missing backups from a device that has the key),
 * or `ready` (unlock on a new device with a backup).
 */
export const identity = query({
  args: {},
  returns: v.object({
    state: v.union(v.literal('none'), v.literal('needsBackup'), v.literal('ready')),
    publicKey: v.union(v.null(), v.string()),
    kid: v.union(v.null(), v.string()),
    backups: v.array(backupRow),
  }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const rows = await backupsOf(ctx, member.userId)
    return {
      state: keyState(member, rows),
      publicKey: member.identityPublicKey ?? null,
      kid: member.identityKid ?? null,
      backups: rows.map(({ userId: _userId, _creationTime: _created, ...row }) => row),
    }
  },
})

/**
 * A challenge sealed to the person's identity public key (libsodium `crypto_box_seal`). The
 * device opens it with `openSealedBox` and passes the result, base64url, as `proof` to set up
 * the key or change a backup. It expires in five minutes and works once.
 *
 * Before the account has a key, the first device names the key it is setting up
 * (`publicKey`), and the challenge is sealed to that: `keys.setup` then takes the proof only
 * for that key, so the key it stores is one the device can open boxes with.
 */
export const challenge = mutation({
  args: { publicKey: v.optional(v.string()), sessionId: v.optional(v.string()) },
  returns: v.object({ sealed: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    const publicKey = member.identityPublicKey ?? args.publicKey
    if (!publicKey) throw new ConvexError('Set up this account’s key first.')
    if (args.publicKey !== undefined && args.publicKey !== publicKey) {
      throw new ConvexError('This account already has an identity key. Unlock it with your password or recovery key.')
    }
    if (!isPublicKey(publicKey)) throw new ConvexError('That isn’t a valid public key.')
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    const old = await ctx.db
      .query('keyChallenges')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(20)
    // A handful outstanding at most; the oldest go.
    for (const row of old.slice(0, Math.max(0, old.length - 4))) await ctx.db.delete(row._id)
    await ctx.db.insert('keyChallenges', {
      userId: member.userId,
      hash: await sha256Hex(encode(secret)),
      publicKey,
      expiresAt,
    })
    return { sealed: encode(sealBox(secret, decode(publicKey))), expiresAt }
  },
})

/**
 * Sets up the identity key with its password and recovery-key backups, with `proof` from
 * `keys.challenge` for this key: on the first device (no key yet) from
 * `keys.challenge({ publicKey })`, and for an account that already has this key but is missing
 * a backup, from `keys.challenge({})`, which adds the missing ones. Repeating it once both
 * exist does nothing; a different key is refused.
 *
 * The server can't open the wraps, so it can't check they hold this key; the client checks
 * that before calling (packages/crypto `makeKeySetup` does).
 */
export const setup = mutation({
  args: {
    publicKey: v.string(),
    password: v.object({ nonce: v.string(), ct: v.string(), params: passwordParams }),
    recovery: wrapped,
    proof: v.string(),
    sessionId: v.optional(v.string()),
  },
  returns: v.object({ kid: v.string() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    if (!isPublicKey(args.publicKey)) throw new ConvexError('That isn’t a valid public key.')
    if (member.identityPublicKey && member.identityPublicKey !== args.publicKey) {
      throw new ConvexError('This account already has an identity key. Unlock it with your password or recovery key.')
    }
    checkWrapped(args.password)
    checkParams(args.password.params)
    checkWrapped(args.recovery)
    const kid = keyIdOf(args.publicKey)
    const backups = await backupsOf(ctx, member.userId)
    const existing = backups.filter((row) => row.kid === kid)
    const missing = (['password', 'recovery'] as const).filter((kind) => !existing.some((row) => row.kind === kind))
    if (missing.length === 0) return { kid }
    await consumeProof(ctx, member.userId, args.proof, args.publicKey)
    if (!member.identityPublicKey) {
      await ctx.db.patch(member._id, { identityPublicKey: args.publicKey, identityKid: kid })
    }
    const revision = await nextRevision(ctx, member, backups)
    const now = Date.now()
    for (const kind of missing) {
      const wrap = kind === 'password' ? args.password : args.recovery
      await ctx.db.insert('keyBackups', { userId: member.userId, kid, kind, ...wrap, revision, createdAt: now })
    }
    await audit(ctx, { kind: 'user', id: member.userId }, 'identity.setup', kid)
    return { kid }
  },
})

/** Checks a replacement for the backup of `kind` (and `credentialId`) against what's stored. */
async function checkReplacement(
  ctx: MutationCtx,
  member: Doc<'members'>,
  args: { kind: Doc<'keyBackups'>['kind']; expectedRevision: number; params?: Params; credentialId?: string },
) {
  if (!member.identityKid) throw new ConvexError('Set up this account’s key first.')
  const backups = await backupsOf(ctx, member.userId)
  const current = backups.filter(
    (row) => row.kind === args.kind && (args.kind !== 'passkey' || row.credentialId === args.credentialId),
  )
  const revision = current.reduce((n, row) => Math.max(n, row.revision), 0)
  if (revision !== args.expectedRevision) {
    throw new ConvexError('This backup changed on another device. Reload and try again.')
  }
  if (args.kind === 'password') {
    if (!args.params) throw new ConvexError('A password backup needs its password settings.')
    checkParams(args.params, current[0]?.params)
  }
  if (args.kind === 'passkey' && current.length === 0) {
    const passkeys = backups.filter((row) => row.kind === 'passkey').length
    if (passkeys >= MAX_PASSKEY_BACKUPS) {
      throw new ConvexError(`You can have at most ${MAX_PASSKEY_BACKUPS} passkey backups. Remove one first.`)
    }
  }
  return { current, backups, kid: member.identityKid }
}

/** Replaces `current` with the new wrap, at the next revision, which it returns. */
async function replaceBackup(
  ctx: MutationCtx,
  member: Doc<'members'>,
  { current, backups, kid }: { current: Doc<'keyBackups'>[]; backups: Doc<'keyBackups'>[]; kid: string },
  wrap: Omit<Doc<'keyBackups'>, '_id' | '_creationTime' | 'userId' | 'kid' | 'revision' | 'createdAt'>,
) {
  const revision = await nextRevision(ctx, member, backups)
  for (const row of current) await ctx.db.delete(row._id)
  await ctx.db.insert('keyBackups', { userId: member.userId, kid, ...wrap, revision, createdAt: Date.now() })
  await audit(ctx, { kind: 'user', id: member.userId }, `identity.backup.${wrap.kind}`, kid)
  return revision
}

/**
 * Replaces the backup of one kind: a new recovery key, or a passkey (one per `credentialId`,
 * at most ten, each with a 32-byte PRF salt). It must wrap the current identity key, come with
 * `proof` from `keys.challenge`, and name the `expectedRevision` it replaces (0 for a new
 * one). A password change goes through `account.changePassword` instead, so the sign-in
 * password changes with it.
 */
export const putBackup = mutation({
  args: {
    kind: v.union(v.literal('recovery'), v.literal('passkey')),
    nonce: v.string(),
    ct: v.string(),
    credentialId: v.optional(v.string()),
    prfSalt: v.optional(v.string()),
    proof: v.string(),
    expectedRevision: v.number(),
    sessionId: v.optional(v.string()),
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const member = await requireMember(ctx)
    checkWrapped(args)
    if (
      args.kind === 'passkey' &&
      !(
        args.credentialId &&
        args.credentialId.length <= MAX_CREDENTIAL_ID_LENGTH &&
        decodedLength(args.credentialId) &&
        args.prfSalt &&
        decodedLength(args.prfSalt) === PRF_SALT_BYTES
      )
    ) {
      throw new ConvexError('A passkey backup needs its credential and a 32-byte PRF salt.')
    }
    const replacing = await checkReplacement(ctx, member, args)
    await consumeKeyProof(ctx, member, args.proof)
    const revision = await replaceBackup(ctx, member, replacing, {
      kind: args.kind,
      nonce: args.nonce,
      ct: args.ct,
      ...(args.kind === 'passkey' ? { credentialId: args.credentialId, prfSalt: args.prfSalt } : {}),
    })
    return { revision }
  },
})

/**
 * Removes a passkey backup, with `proof`. Password and recovery backups are replaced, never
 * removed. A backup made again for the same credential gets a new revision, never its old one.
 */
export const removePasskeyBackup = mutation({
  args: { credentialId: v.string(), proof: v.string(), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { credentialId, proof, sessionId }) => {
    await requireSessionIfGiven(ctx, sessionId)
    const member = await requireMember(ctx)
    await consumeKeyProof(ctx, member, proof)
    // Before a backup goes, the counter holds at least its revision, even for an account
    // whose backups were written before the counter existed.
    const seen = (await backupsOf(ctx, member.userId)).reduce((n, row) => Math.max(n, row.revision), 0)
    if ((member.backupRevision ?? 0) < seen) await ctx.db.patch(member._id, { backupRevision: seen })
    const rows = await ctx.db
      .query('keyBackups')
      .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('kind', 'passkey'))
      .take(50)
    for (const row of rows) if (row.credentialId === credentialId) await ctx.db.delete(row._id)
    return null
  },
})

const passwordWrap = {
  nonce: v.string(),
  ct: v.string(),
  params: passwordParams,
  expectedRevision: v.number(),
  // `account.changePassword`'s `sessionId`, checked again here in the transaction that
  // writes, since the session can end between the action's own check and this.
  sessionId: v.optional(v.string()),
}

/**
 * `account.changePassword`, before anything else: the proof (used up here), the revision and
 * the settings. Checked first so a session without the key can't use the action to test
 * passwords; the revision is checked again when the change commits.
 */
export const checkPasswordChange = internalMutation({
  args: { userId: v.string(), proof: v.string(), ...passwordWrap },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId, args.userId)
    const member = await memberById(ctx, args.userId)
    checkWrapped(args)
    await checkReplacement(ctx, member, {
      kind: 'password',
      expectedRevision: args.expectedRevision,
      params: args.params,
    })
    await consumeKeyProof(ctx, member, args.proof)
    return null
  },
})

/** The person's email-and-password sign-in credential in Better Auth, if they have one. */
export async function credentialOf(ctx: QueryCtx, userId: string) {
  const account = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'account',
    where: [
      { field: 'userId', value: userId },
      { field: 'providerId', value: 'credential' },
    ],
  })) as { _id: string; password?: string | null } | null
  return account?.password ? { accountId: account._id, passwordHash: account.password } : null
}

/**
 * `account.changePassword`'s one write: the sign-in credential and the password backup change
 * together in this transaction, or neither does. It commits only if neither changed since the
 * action read them: the backup is still at `expectedRevision`, and the credential still holds
 * `previousHash`, the hash the current password was checked against. Of two changes racing,
 * one commits and the other is refused with nothing changed.
 */
export const commitPasswordChange = internalMutation({
  args: { userId: v.string(), previousHash: v.string(), newHash: v.string(), ...passwordWrap },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId, args.userId)
    const member = await memberById(ctx, args.userId)
    checkWrapped(args)
    const replacing = await checkReplacement(ctx, member, {
      kind: 'password',
      expectedRevision: args.expectedRevision,
      params: args.params,
    })
    const credential = await credentialOf(ctx, member.userId)
    if (!credential || credential.passwordHash !== args.previousHash) {
      throw new ConvexError('Your password changed on another device. Reload and try again.')
    }
    await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'account',
        where: [{ field: '_id', value: credential.accountId }],
        update: { password: args.newHash, updatedAt: Date.now() },
      },
    })
    const revision = await replaceBackup(ctx, member, replacing, {
      kind: 'password',
      nonce: args.nonce,
      ct: args.ct,
      params: args.params,
    })
    return { revision }
  },
})

async function memberById(ctx: QueryCtx, userId: string) {
  const member = await ctx.db
    .query('members')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .unique()
  if (!member) throw new ConvexError('Your account isn’t a member of this server.')
  return member
}
