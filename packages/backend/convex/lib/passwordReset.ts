import type { MutationCtx } from '../_generated/server'
import { audit } from './audit'
import { randomToken, sha256Hex } from './hash'

// Issuing a password reset link (account.ts has the rest of resetting). Apart from
// account.ts, which loads Better Auth, so members.ts can issue one without loading it on
// every call (lib/session.ts).

/** How long a reset link works. */
const RESET_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Issues a reset link's token for a member, replacing any earlier one. Only the token's hash is
 * stored; the token is returned once.
 */
export async function issueReset(ctx: MutationCtx, userId: string, issuedBy: string) {
  const old = await ctx.db
    .query('passwordResets')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .take(20)
  for (const row of old) await ctx.db.delete(row._id)
  const token = randomToken()
  const expiresAt = Date.now() + RESET_TTL_MS
  await ctx.db.insert('passwordResets', { userId, tokenHash: await sha256Hex(token), issuedBy, expiresAt })
  await audit(ctx, { kind: 'user', id: issuedBy }, 'password.reset.issue', userId)
  return { token, expiresAt }
}
