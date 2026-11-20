import { paginationOptsValidator, paginationResultValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireMember } from './lib/access'
import { retired } from './lib/networks'
import { LOGIN_COMMAND_TTL_MS, queueCommand } from './lib/outbox'
import { envelope, network } from './validators'

/** The most contacts one `contacts.get` asks for: a page of messages' senders. */
const MAX_GHOST_IDS = 100
/** The most rows a page of `list` or `identifiers` holds; the byte bound ends a page early where rows are big. */
const MAX_PAGE_ITEMS = 500
const MAX_PAGE_BYTES = 8 * 1024 * 1024
/** How often one login's contacts' numbers can be asked for again. */
export const CONTACT_SYNC_INTERVAL_MS = 10 * 60 * 1000

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

const pageOptions = (opts: typeof paginationOptsValidator.type) => ({
  ...opts,
  numItems: Math.min(Math.max(1, opts.numItems), MAX_PAGE_ITEMS),
  maximumRowsRead: Math.min(opts.maximumRowsRead ?? MAX_PAGE_ITEMS + 1, MAX_PAGE_ITEMS + 1),
  maximumBytesRead: Math.min(opts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
})

/**
 * Every contact the person has on every network, a page at a time, in no meaningful order:
 * the address book matches them against its cards and links them (client-api.md, People).
 * Profiles are sealed (kind `contact`, object ID `ghostId`).
 */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ network, ghostId: v.string(), sealedProfile: envelope })),
  handler: async (ctx, { paginationOpts }) => {
    const member = await requireMember(ctx)
    const result = await ctx.db
      .query('contacts')
      .withIndex('by_ghost', (q) => q.eq('userId', member.userId))
      .paginate(pageOptions(paginationOpts))
    return {
      ...result,
      page: result.page
        .filter((contact) => !retired(contact))
        .map(({ network, ghostId, sealedProfile }) => ({ network, ghostId, sealedProfile })),
    }
  },
})

/**
 * What each of the person's logins knows their contacts by, a page at a time: one row per
 * login and contact, sealed to the person (kind `contact`, object ID
 * `<ghostId>/identifiers/<loginId>`). The address book matches cards on them.
 */
export const identifiers = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ network, ghostId: v.string(), loginId: v.string(), sealed: envelope })),
  handler: async (ctx, { paginationOpts }) => {
    const member = await requireMember(ctx)
    const result = await ctx.db
      .query('contactIdentifiers')
      .withIndex('by_contact', (q) => q.eq('userId', member.userId))
      .paginate(pageOptions(paginationOpts))
    return {
      ...result,
      page: result.page
        .filter((row) => !retired(row))
        .map(({ network, ghostId, loginId, sealed }) => ({ network, ghostId, loginId, sealed })),
    }
  },
})

/**
 * Asks a connected account for the numbers its chats know contacts by, again (each new
 * contact's comes by itself): on networks where a contact's ID can be their phone number. The
 * numbers arrive as `contactIdentifiers` events. Asking again within ten minutes does nothing;
 * `queued` says whether it asked.
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
