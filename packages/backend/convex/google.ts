import { ConvexError, v } from 'convex/values'
import { googleClientIdProblem } from '@trioditis/core'
import { mutation, query } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireAdmin, requireMember } from './lib/access'
import { audit } from './lib/audit'

// Google Contacts: the OAuth client ID people's apps sign in to Google with, which an admin
// sets. The app reads a person's contacts from Google itself and seals them as People cards,
// so the server only ever holds the client ID (docs/architecture/client-api.md, People).

/** The client ID, or null when no admin has set one up and Google Contacts is read from a file. */
export const contacts = query({
  args: {},
  returns: v.object({ clientId: v.union(v.string(), v.null()) }),
  handler: async (ctx) => {
    await requireMember(ctx)
    const row = await ctx.db
      .query('serverGoogle')
      .withIndex('by_key', (q) => q.eq('key', 'contacts'))
      .unique()
    return { clientId: row?.clientId ?? null }
  },
})

/** Sets the client ID, or removes it with null. */
export const setContacts = mutation({
  args: { clientId: v.union(v.string(), v.null()), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    const clientId = args.clientId?.trim() ?? null
    if (clientId !== null) {
      const problem = googleClientIdProblem(clientId)
      if (problem) throw new ConvexError(problem)
    }
    const row = await ctx.db
      .query('serverGoogle')
      .withIndex('by_key', (q) => q.eq('key', 'contacts'))
      .unique()
    if ((row?.clientId ?? null) === clientId) return null
    if (clientId === null) await ctx.db.delete(row!._id)
    else if (row) await ctx.db.patch(row._id, { clientId, updatedAt: Date.now(), updatedBy: admin.userId })
    else
      await ctx.db.insert('serverGoogle', { key: 'contacts', clientId, updatedAt: Date.now(), updatedBy: admin.userId })
    await audit(ctx, { kind: 'user', id: admin.userId }, clientId ? 'google.contacts.set' : 'google.contacts.clear')
    return null
  },
})
