import { paginationOptsValidator, paginationResultValidator } from 'convex/server'
import { v } from 'convex/values'
import { query } from './_generated/server'
import { requireMember } from './lib/access'
import { retired } from './lib/networks'
import { envelope, network } from './validators'

/** The most contacts a page holds; each is at most 8 KiB sealed (ingest's metadata cap). */
const MAX_PAGE_ITEMS = 500
const MAX_PAGE_BYTES = 8 * 1024 * 1024

const contactRow = v.object({ network, ghostId: v.string(), sealedProfile: envelope })

/**
 * Every contact the person has on every network, a page at a time, in no meaningful order:
 * the address book matches them against its cards and links them (client-api.md, People).
 * Profiles are sealed (kind `contact`, object ID `ghostId`).
 */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(contactRow),
  handler: async (ctx, { paginationOpts }) => {
    const member = await requireMember(ctx)
    const result = await ctx.db
      .query('contacts')
      .withIndex('by_ghost', (q) => q.eq('userId', member.userId))
      .paginate({
        ...paginationOpts,
        numItems: Math.min(Math.max(1, paginationOpts.numItems), MAX_PAGE_ITEMS),
        maximumRowsRead: Math.min(paginationOpts.maximumRowsRead ?? MAX_PAGE_ITEMS + 1, MAX_PAGE_ITEMS + 1),
        maximumBytesRead: Math.min(paginationOpts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
      })
    return {
      ...result,
      page: result.page
        .filter((contact) => !retired(contact))
        .map(({ network, ghostId, sealedProfile }) => ({ network, ghostId, sealedProfile })),
    }
  },
})
