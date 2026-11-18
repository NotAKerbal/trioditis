import { ConvexError, v } from 'convex/values'
import { internal } from './_generated/api'
import { action, internalMutation, type MutationCtx } from './_generated/server'
import { requireUserId } from './auth'
import { chatViewOf } from './lib/chatView'
import { sortKey } from './lib/ingest'
import { sealJson } from './lib/seal'
import { chatKind, envelope, sender } from './validators'

// Demo data for previews and the nightly: a fake-network account with a few contacts and
// chats, sealed on the server to the signed-in person's identity public key. The fixtures are
// made-up text kept here, so sealing them on the server is fine; what's stored is sealed like
// anything a bridge host writes. Only on a deployment with TRIODITIS_DEMO=1 and the fake
// network alone, so it can never mix with real accounts.

const CONTACTS = [
  { ghostId: 'g_demo_alice', name: 'Alice Moreno', handle: '+1 555 0101' },
  { ghostId: 'g_demo_bob', name: 'Bob Chen', handle: '+1 555 0102' },
  { ghostId: 'g_demo_carol', name: 'Carol Singh', handle: '@carol' },
  { ghostId: 'g_demo_dan', name: 'Dan Okafor', handle: '+1 555 0104' },
  { ghostId: 'g_demo_eve', name: 'Eve Laurent', handle: '@eve' },
  { ghostId: 'g_demo_frank', name: 'Frank Ito', handle: '+1 555 0106' },
]

type Fixture = {
  portalId: string
  kind: 'dm' | 'group'
  name: string
  people: string[]
  lines: string[]
  unread: number
  isRequest?: boolean
  snoozed?: boolean
  archived?: boolean
  pinned?: boolean
}

const CHATS: Fixture[] = [
  {
    portalId: 'p_demo_alice',
    kind: 'dm',
    name: 'Alice Moreno',
    people: ['g_demo_alice'],
    lines: [
      'Are we still on for lunch?',
      'Yes! 12:30 at the usual place',
      'Perfect, see you there',
      'Running 5 min late',
    ],
    unread: 2,
    pinned: true,
  },
  {
    portalId: 'p_demo_family',
    kind: 'group',
    name: 'Family',
    people: ['g_demo_alice', 'g_demo_bob', 'g_demo_carol'],
    lines: [
      'Dinner on Sunday?',
      'I can bring dessert',
      'Who’s picking up Grandma?',
      'I will',
      'Photos from last week 📸',
    ],
    unread: 5,
  },
  {
    portalId: 'p_demo_hike',
    kind: 'group',
    name: 'Weekend hike',
    people: ['g_demo_dan', 'g_demo_eve'],
    lines: ['Trailhead at 8?', 'Bring layers, it gets cold up top', 'Forecast looks clear', 'I’ll drive'],
    unread: 0,
  },
  {
    portalId: 'p_demo_bob',
    kind: 'dm',
    name: 'Bob Chen',
    people: ['g_demo_bob'],
    lines: ['Did you see the game?', 'Unbelievable ending', 'Rematch next week?'],
    unread: 1,
  },
  {
    portalId: 'p_demo_carol',
    kind: 'dm',
    name: 'Carol Singh',
    people: ['g_demo_carol'],
    lines: ['Can you review my draft?', 'Sure, send it over', 'Thanks! No rush'],
    unread: 0,
  },
  {
    portalId: 'p_demo_dan',
    kind: 'dm',
    name: 'Dan Okafor',
    people: ['g_demo_dan'],
    lines: ['Hi! We met at the conference', 'Would love to stay in touch'],
    unread: 2,
    isRequest: true,
  },
  {
    portalId: 'p_demo_eve',
    kind: 'dm',
    name: 'Eve Laurent',
    people: ['g_demo_eve'],
    lines: ['Reminder: the report is due Friday', 'I’ll look at it tomorrow'],
    unread: 1,
    snoozed: true,
  },
  {
    portalId: 'p_demo_frank',
    kind: 'dm',
    name: 'Frank Ito',
    people: ['g_demo_frank'],
    lines: ['Old thread about the move', 'All done now, thanks for the help!'],
    unread: 0,
    archived: true,
  },
]

/** How many messages each demo chat gets. */
const MESSAGES_PER_CHAT = 20

/** Whether `demo.seedForMe` works here: a demo deployment with the fake network alone. */
export function demoEnabled() {
  return process.env.TRIODITIS_DEMO === '1' && process.env.TRIODITIS_NETWORKS === 'fake'
}

function assertDemo() {
  if (!demoEnabled()) throw new ConvexError('Demo data is only available on demo deployments.')
}

function loginIdFor(userId: string) {
  return `l_demo_${userId}`
}

/**
 * Starts seeding, or carries on with one that stopped partway: makes the fake account if it
 * isn't there, and says which contacts and chats are still missing. Null if nothing is.
 */
export const begin = internalMutation({
  args: { userId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ publicKey: v.string(), contactsMissing: v.boolean(), chatsMissing: v.array(v.string()) }),
  ),
  handler: async (ctx, { userId }) => {
    assertDemo()
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
    if (!member) throw new ConvexError('Your account isn’t a member of this server.')
    if (!member.identityPublicKey) throw new ConvexError('Set up your key first (keys.setup), then load the demo.')
    const loginId = loginIdFor(userId)
    const existing = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', 'fake').eq('loginId', loginId))
      .unique()
    if (!existing) {
      const now = Date.now()
      await ctx.db.insert('networkAccounts', {
        userId,
        network: 'fake',
        loginId,
        state: 'CONNECTED',
        lastHealthyAt: now,
        updatedAt: now,
      })
    }
    const contactsMissing = !(await hasContact(ctx, userId, CONTACTS.at(-1)!.ghostId))
    const chatsMissing = []
    for (const chat of CHATS) if (!(await hasChat(ctx, userId, chat.portalId))) chatsMissing.push(chat.portalId)
    if (existing && !contactsMissing && chatsMissing.length === 0) return null
    return { publicKey: member.identityPublicKey, contactsMissing, chatsMissing }
  },
})

async function hasContact(ctx: MutationCtx, userId: string, ghostId: string) {
  const row = await ctx.db
    .query('contacts')
    .withIndex('by_ghost', (q) => q.eq('userId', userId).eq('network', 'fake').eq('ghostId', ghostId))
    .first()
  return row !== null
}

async function hasChat(ctx: MutationCtx, userId: string, portalId: string) {
  const row = await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', 'fake').eq('portalId', portalId))
    .first()
  return row !== null
}

export const writeContacts = internalMutation({
  args: { userId: v.string(), contacts: v.array(v.object({ ghostId: v.string(), sealed: envelope })) },
  returns: v.null(),
  handler: async (ctx, { userId, contacts }) => {
    assertDemo()
    // All of them in one transaction, so a seed that stopped partway has all or none.
    for (const contact of contacts.slice(0, 50)) {
      if (await hasContact(ctx, userId, contact.ghostId)) continue
      await ctx.db.insert('contacts', {
        userId,
        network: 'fake',
        ghostId: contact.ghostId,
        sealedProfile: contact.sealed,
      })
    }
    return null
  },
})

async function insertChat(
  ctx: MutationCtx,
  userId: string,
  chat: {
    portalId: string
    kind: 'dm' | 'group' | 'channel' | 'space'
    sealed: typeof envelope.type
    unread: number
    isRequest: boolean
    snoozed: boolean
    archived: boolean
    pinned: boolean
    lastMessageAt: number
  },
) {
  const fields = {
    userId,
    network: 'fake' as const,
    loginId: loginIdFor(userId),
    portalId: chat.portalId,
    kind: chat.kind,
    sealedMeta: chat.sealed,
    lastMessageAt: chat.lastMessageAt,
    unreadCount: chat.unread,
    pinned: chat.pinned,
    archived: chat.archived,
    isRequest: chat.isRequest,
    ...(chat.snoozed ? { snoozedUntil: Date.now() + 24 * 60 * 60 * 1000, woke: false } : {}),
  }
  return await ctx.db.insert('chats', { ...fields, view: chatViewOf(fields) })
}

export const writeChat = internalMutation({
  args: {
    userId: v.string(),
    portalId: v.string(),
    kind: chatKind,
    sealed: envelope,
    unread: v.number(),
    isRequest: v.boolean(),
    snoozed: v.boolean(),
    archived: v.boolean(),
    pinned: v.boolean(),
    messages: v.array(v.object({ eventId: v.string(), networkTs: v.number(), sender, sealed: envelope })),
  },
  returns: v.null(),
  handler: async (ctx, { userId, messages, ...chat }) => {
    assertDemo()
    // A chat and its messages are one transaction: a retry after a failure finds either the
    // whole chat or none of it.
    if (await hasChat(ctx, userId, chat.portalId)) return null
    const bounded = messages.slice(0, 50)
    const lastMessageAt = bounded.reduce((at, message) => Math.max(at, message.networkTs), 0)
    const chatId = await insertChat(ctx, userId, { ...chat, lastMessageAt })
    for (const message of bounded) {
      await ctx.db.insert('messages', {
        userId,
        chatId,
        network: 'fake',
        eventId: message.eventId,
        networkTs: message.networkTs,
        sortKey: sortKey(message.networkTs, message.eventId),
        sender: message.sender,
        sealed: message.sealed,
        sealedObjectId: message.eventId,
        historical: false,
      })
    }
    return null
  },
})

/**
 * Loads the demo data for the signed-in person, once: a connected fake-network account, six
 * contacts and eight chats (two groups, a pinned chat, a message request, a snoozed chat and an
 * archived one) of 20 messages each. It needs `keys.setup` done first. Each contact batch and
 * each chat is written whole, so if it stops partway, calling it again finishes the rest;
 * once everything is there, calling it does nothing (`seeded: false`).
 */
export const seedForMe = action({
  args: {},
  returns: v.object({ seeded: v.boolean() }),
  handler: async (ctx) => {
    assertDemo()
    const userId = await requireUserId(ctx)
    const start = await ctx.runMutation(internal.demo.begin, { userId })
    if (!start) return { seeded: false }
    const recipients = [start.publicKey]
    const seal = (value: unknown, kind: string, objectId: string) =>
      sealJson(value, recipients, { kind, ownerUserId: userId, objectId })
    if (start.contactsMissing) {
      await ctx.runMutation(internal.demo.writeContacts, {
        userId,
        contacts: CONTACTS.map(({ ghostId, name, handle }) => ({
          ghostId,
          sealed: seal({ name, handle }, 'contact', ghostId),
        })),
      })
    }
    const now = Date.now()
    const missing = new Set(start.chatsMissing)
    for (const [index, chat] of CHATS.entries()) {
      if (!missing.has(chat.portalId)) continue
      // Each chat's latest message is a little older than the one before it, so the inbox has an order.
      const newest = now - index * 37 * 60 * 1000
      const messages = Array.from({ length: MESSAGES_PER_CHAT }, (_, n) => {
        const eventId = `e_demo_${chat.portalId}_${n}`
        const fromSelf = n % 3 === 2
        const ghostId = chat.people[n % chat.people.length]!
        return {
          eventId,
          networkTs: newest - (MESSAGES_PER_CHAT - 1 - n) * 4 * 60 * 1000,
          sender: fromSelf ? ({ self: true } as const) : { ghostId },
          sealed: seal({ type: 'text', body: chat.lines[n % chat.lines.length] }, 'message', eventId),
        }
      })
      await ctx.runMutation(internal.demo.writeChat, {
        userId,
        portalId: chat.portalId,
        kind: chat.kind,
        sealed: seal({ name: chat.name }, 'chat', chat.portalId),
        unread: chat.unread,
        isRequest: chat.isRequest ?? false,
        snoozed: chat.snoozed ?? false,
        archived: chat.archived ?? false,
        pinned: chat.pinned ?? false,
        messages,
      })
    }
    return { seeded: true }
  },
})
