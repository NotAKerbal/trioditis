import { paginationOptsValidator, paginationResultValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMember } from './lib/access'
import { retired } from './lib/networks'
import { LOGIN_COMMAND_TTL_MS, queueCommand } from './lib/outbox'
import { envelope, network } from './validators'

/** The most contacts a page holds; each is at most 16 KiB sealed (ingest's metadata cap, twice). */
const MAX_PAGE_ITEMS = 500
const MAX_PAGE_BYTES = 8 * 1024 * 1024
/** How often one login's contact list can be asked for: it can be thousands of contacts. */
export const CONTACT_SYNC_INTERVAL_MS = 10 * 60 * 1000

const contactRow = v.object({
  network,
  ghostId: v.string(),
  sealedProfile: envelope,
  sealedIdentifiers: v.optional(envelope),
})

/**
 * Every contact the person has on every network, a page at a time, in no meaningful order:
 * the address book matches them against its cards and links them (client-api.md, People).
 * Profiles are sealed (kind `contact`, object ID `ghostId`), and so is what the person's own
 * logins know each contact by (object ID `<ghostId>/identifiers`).
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
        .map(({ network, ghostId, sealedProfile, sealedIdentifiers }) => ({
          network,
          ghostId,
          sealedProfile,
          ...(sealedIdentifiers ? { sealedIdentifiers } : {}),
        })),
    }
  },
})

/**
 * Asks a connected account's network for its contact list (the address book a phone shares
 * with WhatsApp or Signal, say). The contacts arrive as `contact` and `contactIdentifiers`
 * events. Asking again within ten minutes does nothing; `queued` says whether it asked.
 */
export const sync = mutation({
  args: { networkAccountId: v.id('networkAccounts') },
  returns: v.object({ queued: v.boolean() }),
  handler: async (ctx, { networkAccountId }) => {
    const member = await requireMember(ctx)
    const account = await ctx.db.get(networkAccountId)
    if (!account || account.userId !== member.userId) throw new ConvexError('That account doesn’t exist.')
    if (account.state !== 'CONNECTED') throw new ConvexError('That account isn’t connected.')
    const now = Date.now()
    if (account.contactsSyncedAt !== undefined && now - account.contactsSyncedAt < CONTACT_SYNC_INTERVAL_MS) {
      return { queued: false }
    }
    await queueCommand(ctx, {
      userId: account.userId,
      network: account.network,
      loginId: account.loginId,
      payload: { type: 'syncContacts' },
      state: 'queued',
      attempts: 0,
      createdAt: now,
      expiresAt: now + LOGIN_COMMAND_TTL_MS,
    })
    await ctx.db.patch(account._id, { contactsSyncedAt: now })
    return { queued: true }
  },
})
