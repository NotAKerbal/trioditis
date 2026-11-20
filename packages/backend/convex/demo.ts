import { ConvexError, v } from 'convex/values'
import type { Network } from '@trioditis/core'
import { internal } from './_generated/api'
import { action, internalMutation, type MutationCtx } from './_generated/server'
import { requireSessionIfGiven, requireUserId } from './auth'
import { chatViewOf } from './lib/chatView'
import { sortKey } from './lib/ingest'
import { refreshLast } from './lib/lastMessage'
import { bridgedNetworks } from './lib/networks'
import { sealJson } from './lib/seal'
import { chatKind, envelope, network, sender } from './validators'

// Demo data for previews and the nightly: accounts on a few networks, with contacts and chats,
// sealed on the server to the signed-in person's identity public key. The fixtures are made-up
// text kept here, so sealing them on the server is fine; what's stored is sealed like anything
// a bridge host writes. The accounts look connected but no bridge host runs them. Only on a
// deployment with TRIODITIS_DEMO=1 and no bridge host at all (no TRIODITIS_NETWORKS), so it
// can never mix with real accounts: nothing from a real network can arrive there.

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
  network: Network
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
    network: 'whatsapp',
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
    network: 'whatsapp',
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
    network: 'signal',
    kind: 'group',
    name: 'Weekend hike',
    people: ['g_demo_dan', 'g_demo_eve'],
    lines: ['Trailhead at 8?', 'Bring layers, it gets cold up top', 'Forecast looks clear', 'I’ll drive'],
    unread: 0,
  },
  {
    portalId: 'p_demo_bob',
    network: 'gmessages',
    kind: 'dm',
    name: 'Bob Chen',
    people: ['g_demo_bob'],
    lines: ['Did you see the game?', 'Unbelievable ending', 'Rematch next week?'],
    unread: 1,
  },
  {
    portalId: 'p_demo_carol',
    network: 'telegram',
    kind: 'dm',
    name: 'Carol Singh',
    people: ['g_demo_carol'],
    lines: ['Can you review my draft?', 'Sure, send it over', 'Thanks! No rush'],
    unread: 0,
  },
  {
    portalId: 'p_demo_dan',
    network: 'instagram',
    kind: 'dm',
    name: 'Dan Okafor',
    people: ['g_demo_dan'],
    lines: ['Hi! We met at the conference', 'Would love to stay in touch'],
    unread: 2,
    isRequest: true,
  },
  {
    portalId: 'p_demo_eve',
    network: 'slack',
    kind: 'dm',
    name: 'Eve Laurent',
    people: ['g_demo_eve'],
    lines: ['Reminder: the report is due Friday', 'I’ll look at it tomorrow'],
    unread: 1,
    snoozed: true,
  },
  {
    portalId: 'p_demo_frank',
    network: 'meta',
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

/** The networks the demo chats are on, each with one demo account. */
const DEMO_NETWORKS = [...new Set(CHATS.map((chat) => chat.network))]

/** Each contact on each network a chat of theirs is on, as contacts are kept per network. */
const DEMO_CONTACTS = CONTACTS.flatMap((contact) =>
  DEMO_NETWORKS.filter((name) =>
    CHATS.some((chat) => chat.network === name && chat.people.includes(contact.ghostId)),
  ).map((name) => ({ ...contact, network: name })),
)

/** Whether `demo.seedForMe` works here: a demo deployment with no bridge host. */
export function demoEnabled() {
  return process.env.TRIODITIS_DEMO === '1' && bridgedNetworks().size === 0
}

function assertDemo() {
  if (!demoEnabled()) throw new ConvexError('Demo data is only available on demo deployments.')
}

function loginIdFor(userId: string) {
  return `l_demo_${userId}`
}

/**
 * Starts seeding, or carries on with one that stopped partway: makes the demo accounts that
 * aren't there, and says which contacts and chats are still missing. Null if nothing is.
 */
export const begin = internalMutation({
  args: { userId: v.string(), sessionId: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({ publicKey: v.string(), contactsMissing: v.boolean(), chatsMissing: v.array(v.string()) }),
  ),
  handler: async (ctx, { userId, sessionId }) => {
    assertDemo()
    await requireSessionIfGiven(ctx, sessionId, userId)
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
    if (!member) throw new ConvexError('Your account isn’t a member of this server.')
    if (!member.identityPublicKey) throw new ConvexError('Set up your key first (keys.setup), then load the demo.')
    const loginId = loginIdFor(userId)
    let accountsMissing = false
    for (const name of DEMO_NETWORKS) {
      const existing = await ctx.db
        .query('networkAccounts')
        .withIndex('by_login', (q) => q.eq('network', name).eq('loginId', loginId))
        .unique()
      if (existing) continue
      accountsMissing = true
      const now = Date.now()
      await ctx.db.insert('networkAccounts', {
        userId,
        network: name,
        loginId,
        state: 'CONNECTED',
        lastHealthyAt: now,
        updatedAt: now,
      })
    }
    const last = DEMO_CONTACTS.at(-1)!
    const contactsMissing = !(await hasContact(ctx, userId, last.network, last.ghostId))
    const chatsMissing = []
    for (const chat of CHATS) {
      if (!(await hasChat(ctx, userId, chat.network, chat.portalId))) chatsMissing.push(chat.portalId)
    }
    if (!accountsMissing && !contactsMissing && chatsMissing.length === 0) return null
    return { publicKey: member.identityPublicKey, contactsMissing, chatsMissing }
  },
})

async function hasContact(ctx: MutationCtx, userId: string, name: Network, ghostId: string) {
  const row = await ctx.db
    .query('contacts')
    .withIndex('by_ghost', (q) => q.eq('userId', userId).eq('network', name).eq('ghostId', ghostId))
    .first()
  return row !== null
}

async function hasChat(ctx: MutationCtx, userId: string, name: Network, portalId: string) {
  const row = await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', name).eq('portalId', portalId))
    .first()
  return row !== null
}

export const writeContacts = internalMutation({
  args: {
    userId: v.string(),
    contacts: v.array(
      v.object({
        network,
        ghostId: v.string(),
        sealed: envelope,
        identifiers: v.optional(v.array(v.object({ loginId: v.string(), sealed: envelope }))),
      }),
    ),
    sessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { userId, contacts, sessionId }) => {
    assertDemo()
    await requireSessionIfGiven(ctx, sessionId, userId)
    // All of them in one transaction, so a seed that stopped partway has all or none.
    for (const contact of contacts.slice(0, 50)) {
      if (await hasContact(ctx, userId, contact.network, contact.ghostId)) continue
      await ctx.db.insert('contacts', {
        userId,
        network: contact.network,
        ghostId: contact.ghostId,
        sealedProfile: contact.sealed,
        ...(contact.identifiers ? { identifiers: contact.identifiers } : {}),
      })
    }
    return null
  },
})

async function insertChat(
  ctx: MutationCtx,
  userId: string,
  chat: {
    network: Network
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
    network: chat.network,
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
    network,
    portalId: v.string(),
    kind: chatKind,
    sealed: envelope,
    unread: v.number(),
    isRequest: v.boolean(),
    snoozed: v.boolean(),
    archived: v.boolean(),
    pinned: v.boolean(),
    messages: v.array(v.object({ eventId: v.string(), networkTs: v.number(), sender, sealed: envelope })),
    sessionId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { userId, messages, sessionId, ...chat }) => {
    assertDemo()
    await requireSessionIfGiven(ctx, sessionId, userId)
    // A chat and its messages are one transaction: a retry after a failure finds either the
    // whole chat or none of it.
    if (await hasChat(ctx, userId, chat.network, chat.portalId)) return null
    const bounded = messages.slice(0, 50)
    const lastMessageAt = bounded.reduce((at, message) => Math.max(at, message.networkTs), 0)
    const chatId = await insertChat(ctx, userId, { ...chat, lastMessageAt })
    for (const message of bounded) {
      await ctx.db.insert('messages', {
        userId,
        chatId,
        network: chat.network,
        eventId: message.eventId,
        networkTs: message.networkTs,
        sortKey: sortKey(message.networkTs, message.eventId),
        sender: message.sender,
        sealed: message.sealed,
        sealedObjectId: message.eventId,
        historical: false,
      })
    }
    await refreshLast(ctx, chatId)
    return null
  },
})

/**
 * Loads the demo data for the signed-in person, once: a connected account on each of seven
 * networks, six contacts and eight chats (two groups, a pinned chat, a message request, a snoozed chat and an
 * archived one) of 20 messages each. It needs `keys.setup` done first. Each contact batch and
 * each chat is written whole, so if it stops partway, calling it again finishes the rest;
 * once everything is there, calling it does nothing (`seeded: false`).
 */
export const seedForMe = action({
  args: { sessionId: v.optional(v.string()) },
  returns: v.object({ seeded: v.boolean() }),
  handler: async (ctx, { sessionId }) => {
    assertDemo()
    // Bound to the page's session like the key writes: the data is sealed to this user's key.
    const userId = (await requireSessionIfGiven(ctx, sessionId)) ?? (await requireUserId(ctx))
    const start = await ctx.runMutation(internal.demo.begin, { userId, sessionId })
    if (!start) return { seeded: false }
    const recipients = [start.publicKey]
    const seal = (value: unknown, kind: string, objectId: string) =>
      sealJson(value, recipients, { kind, ownerUserId: userId, objectId })
    if (start.contactsMissing) {
      await ctx.runMutation(internal.demo.writeContacts, {
        userId,
        sessionId,
        contacts: DEMO_CONTACTS.map(({ network, ghostId, name, handle }) => ({
          network,
          ghostId,
          sealed: seal({ name, handle }, 'contact', ghostId),
          // What a login's contact list sends (contacts.sync): the identifiers as URIs, so the
          // address book can match them.
          identifiers: [
            {
              loginId: loginIdFor(userId),
              sealed: seal(
                {
                  identifiers: [
                    handle.startsWith('+') ? `tel:${handle.replaceAll(' ', '')}` : `${network}:${handle.slice(1)}`,
                  ],
                },
                'contact',
                `${ghostId}/identifiers/${loginIdFor(userId)}`,
              ),
            },
          ],
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
        sessionId,
        network: chat.network,
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
