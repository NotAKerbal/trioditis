import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

/** Appends to the audit log. Never pass content; only IDs. */
export async function audit(ctx: MutationCtx, actor: Doc<'auditLog'>['actor'], action: string, target?: string) {
  await ctx.db.insert('auditLog', { actor, action, at: Date.now(), ...(target ? { target } : {}) })
}
