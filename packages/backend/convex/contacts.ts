import { ConvexError, v } from 'convex/values'
import { query } from './_generated/server'
import { requireMember } from './lib/access'
import { envelope, network } from './validators'

/** The most contacts one `contacts.get` asks for: a page of messages' senders. */
const MAX_GHOST_IDS = 100

/**
 * The person's contacts on a network with these ghost IDs, for naming the senders on a page of
 * messages. Profiles are sealed (kind `contact`, object ID `ghostId`), and each is at most 8 KiB
 * (ingest's metadata cap), so a full answer stays small. A ghost the person has no contact for
 * is left out.
 */
export const get = query({
  args: { network, ghostIds: v.array(v.string()) },
  returns: v.array(v.object({ ghostId: v.string(), sealedProfile: envelope })),
  handler: async (ctx, { network, ghostIds }) => {
    const member = await requireMember(ctx)
    if (ghostIds.length > MAX_GHOST_IDS) throw new ConvexError('Ask for at most 100 contacts at once.')
    const out: { ghostId: string; sealedProfile: typeof envelope.type }[] = []
    for (const ghostId of new Set(ghostIds)) {
      const contact = await ctx.db
        .query('contacts')
        .withIndex('by_ghost', (q) => q.eq('userId', member.userId).eq('network', network).eq('ghostId', ghostId))
        .unique()
      if (contact) out.push({ ghostId, sealedProfile: contact.sealedProfile })
    }
    return out
  },
})
