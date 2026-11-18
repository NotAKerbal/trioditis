import { ConvexError, v } from 'convex/values'
import type { Doc } from './_generated/dataModel'
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
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
// those wraps. Changing a backup needs proof that the device holds the private key (a
// challenge only it can open), and names the revision it replaces, so a stolen session or a
// stale device can't replace someone's backups and lock them out. See
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

/** Uses up a challenge the device opened. Each works once, within five minutes. */
async function consumeProof(ctx: MutationCtx, userId: string, proof: string) {
  const hash = await sha256Hex(proof)
  const now = Date.now()
  const rows = await ctx.db
    .query('keyChallenges')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(20)
  const match = rows.find((row) => row.hash === hash && row.expiresAt > now)
  for (const row of rows) if (row === match || row.expiresAt <= now) await ctx.db.delete(row._id)
  if (!match) throw new ConvexError('That proof of your key has expired or was already used. Try again.')
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
 * device opens it with `openSealedBox` and passes the result, base64url, as `proof` to change
 * a backup. It expires in five minutes and works once.
 */
export const challenge = mutation({
  args: {},
  returns: v.object({ sealed: v.string(), expiresAt: v.number() }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    if (!member.identityPublicKey) throw new ConvexError('Set up this account’s key first.')
    const secret = crypto.getRandomValues(new Uint8Array(32))
    const expiresAt = Date.now() + CHALLENGE_TTL_MS
    const old = await ctx.db
      .query('keyChallenges')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(20)
    // A handful outstanding at most; the oldest go.
    for (const row of old.slice(0, Math.max(0, old.length - 4))) await ctx.db.delete(row._id)
    await ctx.db.insert('keyChallenges', { userId: member.userId, hash: await sha256Hex(encode(secret)), expiresAt })
    return { sealed: encode(sealBox(secret, decode(member.identityPublicKey))), expiresAt }
  },
})

/**
 * Sets up the identity key with its password and recovery-key backups. On the first device
 * (no key yet) that's all it takes. For an account that already has this key but is missing
 * a backup, it adds the missing ones, with `proof` from `keys.challenge`. Repeating it once
 * both exist does nothing; a different key is refused.
 */
export const setup = mutation({
  args: {
    publicKey: v.string(),
    password: v.object({ nonce: v.string(), ct: v.string(), params: passwordParams }),
    recovery: wrapped,
    proof: v.optional(v.string()),
  },
  returns: v.object({ kid: v.string() }),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    if (!isPublicKey(args.publicKey)) throw new ConvexError('That isn’t a valid public key.')
    if (member.identityPublicKey && member.identityPublicKey !== args.publicKey) {
      throw new ConvexError('This account already has an identity key. Unlock it with your password or recovery key.')
    }
    checkWrapped(args.password)
    checkParams(args.password.params)
    checkWrapped(args.recovery)
    const kid = keyIdOf(args.publicKey)
    const existing = (await backupsOf(ctx, member.userId)).filter((row) => row.kid === kid)
    const missing = (['password', 'recovery'] as const).filter((kind) => !existing.some((row) => row.kind === kind))
    if (missing.length === 0) return { kid }
    if (member.identityPublicKey) {
      if (!args.proof) throw new ConvexError('Prove this device has the key first (keys.challenge).')
      await consumeProof(ctx, member.userId, args.proof)
    } else {
      await ctx.db.patch(member._id, { identityPublicKey: args.publicKey, identityKid: kid })
    }
    const now = Date.now()
    for (const kind of missing) {
      const wrap = kind === 'password' ? args.password : args.recovery
      await ctx.db.insert('keyBackups', { userId: member.userId, kid, kind, ...wrap, revision: 1, createdAt: now })
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
  const current = (await backupsOf(ctx, member.userId)).filter(
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
  return { current, revision, kid: member.identityKid }
}

async function replaceBackup(
  ctx: MutationCtx,
  userId: string,
  kid: string,
  current: Doc<'keyBackups'>[],
  revision: number,
  wrap: Omit<Doc<'keyBackups'>, '_id' | '_creationTime' | 'userId' | 'kid' | 'revision' | 'createdAt'>,
) {
  for (const row of current) await ctx.db.delete(row._id)
  await ctx.db.insert('keyBackups', { userId, kid, ...wrap, revision: revision + 1, createdAt: Date.now() })
  await audit(ctx, { kind: 'user', id: userId }, `identity.backup.${wrap.kind}`, kid)
}

/**
 * Replaces the backup of one kind: a new recovery key, or a passkey (one per `credentialId`).
 * It must wrap the current identity key, come with `proof` from `keys.challenge`, and name
 * the `expectedRevision` it replaces (0 for a new one). A password change goes through
 * `account.changePassword` instead, so the sign-in password changes with it.
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
  },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    checkWrapped(args)
    if (args.kind === 'passkey' && (!args.credentialId || args.credentialId.length > 512 || !args.prfSalt)) {
      throw new ConvexError('A passkey backup needs its credential and PRF salt.')
    }
    const { current, revision, kid } = await checkReplacement(ctx, member, args)
    await consumeProof(ctx, member.userId, args.proof)
    await replaceBackup(ctx, member.userId, kid, current, revision, {
      kind: args.kind,
      nonce: args.nonce,
      ct: args.ct,
      ...(args.kind === 'passkey' ? { credentialId: args.credentialId, prfSalt: args.prfSalt } : {}),
    })
    return { revision: revision + 1 }
  },
})

/** Removes a passkey backup, with `proof`. Password and recovery backups are replaced, never removed. */
export const removePasskeyBackup = mutation({
  args: { credentialId: v.string(), proof: v.string() },
  returns: v.null(),
  handler: async (ctx, { credentialId, proof }) => {
    const member = await requireMember(ctx)
    await consumeProof(ctx, member.userId, proof)
    const rows = await ctx.db
      .query('keyBackups')
      .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('kind', 'passkey'))
      .take(50)
    for (const row of rows) if (row.credentialId === credentialId) await ctx.db.delete(row._id)
    return null
  },
})

const passwordWrap = { nonce: v.string(), ct: v.string(), params: passwordParams, expectedRevision: v.number() }

/** `account.changePassword`, before it touches the sign-in password: proof, revision and settings. */
export const checkPasswordChange = internalMutation({
  args: { userId: v.string(), proof: v.string(), ...passwordWrap },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await memberById(ctx, args.userId)
    checkWrapped(args)
    await checkReplacement(ctx, member, {
      kind: 'password',
      expectedRevision: args.expectedRevision,
      params: args.params,
    })
    await consumeProof(ctx, member.userId, args.proof)
    return null
  },
})

/** `account.changePassword`, once the sign-in password has changed: stores the new wrap. */
export const storePasswordWrap = internalMutation({
  args: { userId: v.string(), ...passwordWrap },
  returns: v.object({ revision: v.number() }),
  handler: async (ctx, args) => {
    const member = await memberById(ctx, args.userId)
    const { current, revision, kid } = await checkReplacement(ctx, member, {
      kind: 'password',
      expectedRevision: args.expectedRevision,
      params: args.params,
    })
    await replaceBackup(ctx, member.userId, kid, current, revision, {
      kind: 'password',
      nonce: args.nonce,
      ct: args.ct,
      params: args.params,
    })
    return { revision: revision + 1 }
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
