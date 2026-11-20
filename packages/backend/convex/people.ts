import { paginationOptsValidator, paginationResultValidator } from 'convex/server'
import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireMember } from './lib/access'
import { isEnvelope } from './lib/envelope'
import { envelope } from './validators'

// The person's address book. Each card is sealed to the person: kind `person`, object ID
// `personKey`, which the client picks before sealing (16 to 64 letters, digits, `-` and `_`).
// Names, numbers, addresses and which network contacts a card links all live inside it, so
// the server stores only how many cards there are and when each changed. See client-api.md,
// People.

const PERSON_KEY = /^[A-Za-z0-9_-]{16,64}$/
/** The most cards one person can have: more than most phones' address books. */
export const MAX_PEOPLE = 10_000
/** The most a sealed card can be: room for a long note and a small photo. */
export const MAX_PERSON_BYTES = 64 * 1024
/** The most cards one `put` or `remove` takes, so an import is a few calls, each well inside a transaction. */
export const MAX_PEOPLE_PER_CALL = 100
/** The most cards a page holds; at the size cap that's 6.4 MiB, under a query's 16 MiB. */
const MAX_PAGE_ITEMS = 100
const MAX_PAGE_BYTES = 8 * 1024 * 1024

const personRow = v.object({ personKey: v.string(), sealed: envelope, updatedAt: v.number() })

/** The person's cards, a page at a time, in `personKey` order (which says nothing about who's on them). */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(personRow),
  handler: async (ctx, { paginationOpts }) => {
    const member = await requireMember(ctx)
    const result = await ctx.db
      .query('people')
      .withIndex('by_user', (q) => q.eq('userId', member.userId))
      .paginate({
        ...paginationOpts,
        numItems: Math.min(Math.max(1, paginationOpts.numItems), MAX_PAGE_ITEMS),
        maximumRowsRead: Math.min(paginationOpts.maximumRowsRead ?? MAX_PAGE_ITEMS + 1, MAX_PAGE_ITEMS + 1),
        maximumBytesRead: Math.min(paginationOpts.maximumBytesRead ?? MAX_PAGE_BYTES, MAX_PAGE_BYTES),
      })
    return {
      ...result,
      page: result.page.map(({ personKey, sealed, updatedAt }) => ({ personKey, sealed, updatedAt })),
    }
  },
})

/**
 * Adds cards, or replaces the ones with these `personKey`s: a new card, an edit, a link to a
 * network contact, or a page of an import. All of them are stored, or none.
 */
export const put = mutation({
  args: {
    people: v.array(v.object({ personKey: v.string(), sealed: envelope })),
    sessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { people, sessionId }) => {
    // A card sealed on a page another tab's sign-in has switched would be stored for the
    // other account, which can't open it.
    await requireSessionIfGiven(ctx, sessionId)
    const member = await requireMember(ctx)
    if (people.length > MAX_PEOPLE_PER_CALL)
      throw new ConvexError(`Save at most ${MAX_PEOPLE_PER_CALL} people at once.`)
    if (new Set(people.map((p) => p.personKey)).size !== people.length) {
      throw new ConvexError('Each person can be saved once per call.')
    }
    for (const { personKey, sealed } of people) {
      if (!PERSON_KEY.test(personKey)) throw new ConvexError('That person ID isn’t valid.')
      if (!isEnvelope(sealed, MAX_PERSON_BYTES)) throw new ConvexError('That person isn’t sealed, or is too long.')
    }
    const now = Date.now()
    let added = 0
    for (const { personKey, sealed } of people) {
      const existing = await ctx.db
        .query('people')
        .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('personKey', personKey))
        .unique()
      if (existing) {
        await ctx.db.patch(existing._id, { sealed, updatedAt: now })
      } else {
        await ctx.db.insert('people', { userId: member.userId, personKey, sealed, updatedAt: now })
        added++
      }
    }
    if (added) {
      const count = (member.peopleCount ?? 0) + added
      if (count > MAX_PEOPLE) throw new ConvexError(`You can have at most ${MAX_PEOPLE.toLocaleString('en')} people.`)
      await ctx.db.patch(member._id, { peopleCount: count })
    }
    return null
  },
})

/** Deletes cards. A key with no card is skipped, so deleting twice is harmless. */
export const remove = mutation({
  args: { personKeys: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, { personKeys }) => {
    const member = await requireMember(ctx)
    if (personKeys.length > MAX_PEOPLE_PER_CALL) {
      throw new ConvexError(`Delete at most ${MAX_PEOPLE_PER_CALL} people at once.`)
    }
    let removed = 0
    for (const personKey of new Set(personKeys)) {
      const existing = await ctx.db
        .query('people')
        .withIndex('by_user', (q) => q.eq('userId', member.userId).eq('personKey', personKey))
        .unique()
      if (existing) {
        await ctx.db.delete(existing._id)
        removed++
      }
    }
    if (removed) await ctx.db.patch(member._id, { peopleCount: Math.max(0, (member.peopleCount ?? 0) - removed) })
    return null
  },
})
