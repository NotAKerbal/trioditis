import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMember } from './lib/access'
import { audit } from './lib/audit'
import { decodedLength, isPublicKey, keyIdOf } from './lib/envelope'

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
// those wraps. See docs/architecture/client-api.md, Keys.

const backupKind = v.union(v.literal('password'), v.literal('recovery'), v.literal('passkey'))
const passwordParams = v.object({
  alg: v.literal('argon2id13'),
  salt: v.string(),
  opslimit: v.number(),
  memlimit: v.number(),
})
const wrapped = v.object({ nonce: v.string(), ct: v.string() })

/** A wrapped 32-byte X25519 private key: a 24-byte nonce, and 32 bytes plus a 16-byte tag. */
function checkWrapped({ nonce, ct }: { nonce: string; ct: string }) {
  if (decodedLength(nonce) !== 24 || decodedLength(ct) !== 48) throw new ConvexError('That isn’t a wrapped key.')
}

function checkParams(params: { salt: string; opslimit: number; memlimit: number }) {
  // At least libsodium's interactive limits, so a backup can't be made trivially guessable,
  // and at most what a browser can afford.
  const sane =
    decodedLength(params.salt) === 16 &&
    Number.isInteger(params.opslimit) &&
    params.opslimit >= 2 &&
    params.opslimit <= 10 &&
    Number.isInteger(params.memlimit) &&
    params.memlimit >= 64 * 1024 * 1024 &&
    params.memlimit <= 1024 * 1024 * 1024
  if (!sane) throw new ConvexError('Those password settings aren’t allowed.')
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
  createdAt: v.number(),
})

/**
 * The signed-in person's identity public key and its backups. A new device fetches these, asks
 * for the password (or recovery key), and unwraps the private key locally.
 */
export const identity = query({
  args: {},
  returns: v.object({
    publicKey: v.union(v.null(), v.string()),
    kid: v.union(v.null(), v.string()),
    backups: v.array(backupRow),
  }),
  handler: async (ctx) => {
    const member = await requireMember(ctx)
    const rows = await ctx.db
      .query('keyBackups')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(50)
    return {
      publicKey: member.identityPublicKey ?? null,
      kid: member.identityKid ?? null,
      backups: rows.map(({ userId: _userId, _creationTime: _created, ...row }) => row),
    }
  },
})

/**
 * First-device setup: records the identity public key together with its password and
 * recovery-key backups, in one step, so nobody ends up with a key they can't recover. Running
 * it again with the same key and backups does nothing; a different key is refused.
 */
export const setup = mutation({
  args: {
    publicKey: v.string(),
    password: v.object({ nonce: v.string(), ct: v.string(), params: passwordParams }),
    recovery: wrapped,
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
    const existing = await ctx.db
      .query('keyBackups')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .take(50)
    if (member.identityPublicKey && existing.some((row) => row.kid === kid)) return { kid }
    const now = Date.now()
    await ctx.db.patch(member._id, { identityPublicKey: args.publicKey, identityKid: kid })
    await ctx.db.insert('keyBackups', {
      userId: member.userId,
      kid,
      kind: 'password',
      ...args.password,
      createdAt: now,
    })
    await ctx.db.insert('keyBackups', {
      userId: member.userId,
      kid,
      kind: 'recovery',
      ...args.recovery,
      createdAt: now,
    })
    await audit(ctx, { kind: 'user', id: member.userId }, 'identity.setup', kid)
    return { kid }
  },
})

/**
 * Replaces the backup of one kind: a changed password, a new recovery key, or a passkey
 * (one per `credentialId`). It must wrap the current identity key.
 */
export const putBackup = mutation({
  args: {
    kind: backupKind,
    nonce: v.string(),
    ct: v.string(),
    params: v.optional(passwordParams),
    credentialId: v.optional(v.string()),
    prfSalt: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    if (!member.identityKid) throw new ConvexError('Set up this account’s key first.')
    checkWrapped(args)
    if (args.kind === 'password') {
      if (!args.params) throw new ConvexError('A password backup needs its password settings.')
      checkParams(args.params)
    }
    if (args.kind === 'passkey' && (!args.credentialId || args.credentialId.length > 512 || !args.prfSalt)) {
      throw new ConvexError('A passkey backup needs its credential and PRF salt.')
    }
    const replaced = (
      await ctx.db
        .query('keyBackups')
        .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('kind', args.kind))
        .take(50)
    ).filter((row) => args.kind !== 'passkey' || row.credentialId === args.credentialId)
    for (const row of replaced) await ctx.db.delete(row._id)
    await ctx.db.insert('keyBackups', {
      userId: member.userId,
      kid: member.identityKid,
      kind: args.kind,
      nonce: args.nonce,
      ct: args.ct,
      ...(args.kind === 'password' ? { params: args.params } : {}),
      ...(args.kind === 'passkey' ? { credentialId: args.credentialId, prfSalt: args.prfSalt } : {}),
      createdAt: Date.now(),
    })
    await audit(ctx, { kind: 'user', id: member.userId }, `identity.backup.${args.kind}`, member.identityKid)
    return null
  },
})

/** Removes a passkey backup. The password and recovery-key backups can be replaced, not removed. */
export const removePasskeyBackup = mutation({
  args: { credentialId: v.string() },
  returns: v.null(),
  handler: async (ctx, { credentialId }) => {
    const member = await requireMember(ctx)
    const rows = await ctx.db
      .query('keyBackups')
      .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('kind', 'passkey'))
      .take(50)
    for (const row of rows) if (row.credentialId === credentialId) await ctx.db.delete(row._id)
    return null
  },
})
