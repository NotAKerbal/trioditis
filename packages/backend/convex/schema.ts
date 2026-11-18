import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { chatKind, commandPayload, deliveryState, envelope, loginState, loginStep, network, sender } from './validators'

// Trioditis's tables. Better Auth's are in the betterAuth component (./betterAuth).
//
// Every row that holds content is scoped to one person (`userId`, the Better Auth user ID)
// and holds it sealed: chat names, contact names and message bodies are envelopes only that
// person's devices (and agents they grant) can open. See docs/architecture/sealing.md.
export default defineSchema({
  members: defineTable({
    userId: v.string(),
    role: v.union(v.literal('admin'), v.literal('member')),
    /** The person's identity public key, base64url, set by their first device. */
    identityPublicKey: v.optional(v.string()),
    identityKid: v.optional(v.string()),
    createdAt: v.number(),
  }).index('by_userId', ['userId']),

  invitations: defineTable({
    email: v.string(),
    /** SHA-256 of the token in the invite link. The token itself is never stored. */
    tokenHash: v.string(),
    role: v.union(v.literal('admin'), v.literal('member')),
    invitedBy: v.string(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.string()),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_email', ['email']),

  /** One connected account on one network, e.g. Isaac's WhatsApp. */
  networkAccounts: defineTable({
    userId: v.string(),
    network,
    loginId: v.string(),
    state: loginState,
    error: v.optional(v.string()),
    lastHealthyAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_login', ['network', 'loginId']),

  loginSessions: defineTable({
    userId: v.string(),
    network,
    state: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('complete'),
      v.literal('cancelled'),
      v.literal('error'),
    ),
    step: v.optional(loginStep),
    loginId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  chats: defineTable({
    userId: v.string(),
    network,
    loginId: v.string(),
    portalId: v.string(),
    kind: chatKind,
    /** Name, topic and avatar. Missing until the bridge host has described the chat. */
    sealedMeta: v.optional(envelope),
    parentPortalId: v.optional(v.string()),
    lastMessageAt: v.number(),
    unreadCount: v.number(),
    pinned: v.boolean(),
    archived: v.boolean(),
    mutedUntil: v.optional(v.number()),
    deleted: v.optional(v.boolean()),
  })
    .index('by_user_lastMessage', ['userId', 'lastMessageAt'])
    .index('by_portal', ['userId', 'network', 'portalId']),

  contacts: defineTable({
    userId: v.string(),
    network,
    ghostId: v.string(),
    sealedProfile: envelope,
  }).index('by_ghost', ['userId', 'network', 'ghostId']),

  messages: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    network,
    /** The bridge host's deterministic event ID: the dedup key. `pending:<clientMessageId>` until a send is echoed. */
    eventId: v.string(),
    networkTs: v.number(),
    /** Network timestamp, then event ID: a stable order that ignores arrival order. */
    sortKey: v.string(),
    sender,
    /** Sealed with object ID `sealedObjectId`. Removed when the message is deleted for everyone. */
    sealed: v.optional(envelope),
    /** `eventId`, or `clientMessageId` for the person's own pending copy. */
    sealedObjectId: v.string(),
    historical: v.boolean(),
    replyTo: v.optional(v.string()),
    threadRoot: v.optional(v.string()),
    clientMessageId: v.optional(v.string()),
    /** The latest edit, sealed with object ID `editEventId`. */
    sealedEdit: v.optional(envelope),
    editEventId: v.optional(v.string()),
    editedAt: v.optional(v.number()),
    redactedAt: v.optional(v.number()),
    /** For the person's own sends. */
    delivery: v.optional(deliveryState),
    sentByAgentId: v.optional(v.string()),
  })
    .index('by_event', ['userId', 'network', 'eventId'])
    .index('by_chat_sort', ['chatId', 'sortKey'])
    .index('by_clientMessageId', ['userId', 'clientMessageId']),

  reactions: defineTable({
    userId: v.string(),
    messageId: v.id('messages'),
    /** `self`, or the ghost ID. */
    senderKey: v.string(),
    key: v.string(),
    networkTs: v.number(),
  }).index('by_message', ['messageId', 'senderKey', 'key']),

  receipts: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    senderKey: v.string(),
    upToEventId: v.string(),
    networkTs: v.number(),
  }).index('by_chat_sender', ['chatId', 'senderKey']),

  typing: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    senderKey: v.string(),
    expiresAt: v.number(),
  }).index('by_chat_sender', ['chatId', 'senderKey']),

  /**
   * Commands for the bridge host. Each row's ID is the command's `commandId`, so the bridge
   * host runs a command once however often the gateway delivers it.
   */
  outbox: defineTable({
    userId: v.string(),
    network,
    loginId: v.optional(v.string()),
    /** Commands for one chat go out in order, one at a time. */
    chatId: v.optional(v.id('chats')),
    payload: commandPayload,
    /** `queued` → `claimed` (leased by a gateway) → `dispatched` (bridge host accepted it) or `rejected`. */
    state: v.union(
      v.literal('queued'),
      v.literal('claimed'),
      v.literal('dispatched'),
      v.literal('rejected'),
      v.literal('expired'),
    ),
    leaseUntil: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    /** For sends: where the message is. Never reset to `queued` by an ambiguous outcome. */
    delivery: v.optional(deliveryState),
    clientMessageId: v.optional(v.string()),
    createdAt: v.number(),
    /** A send still queued after this asks the person before it goes out. */
    expiresAt: v.optional(v.number()),
  })
    .index('by_state', ['state', 'createdAt'])
    .index('by_chat', ['chatId', 'state', 'createdAt'])
    .index('by_clientMessageId', ['userId', 'clientMessageId']),

  /** Each bridge host's position in its event journal. */
  bridgeHosts: defineTable({
    hostId: v.string(),
    network,
    commandAddr: v.string(),
    lastSeq: v.number(),
    updatedAt: v.number(),
  }).index('by_hostId', ['hostId']),

  /** Events that couldn't be applied, kept for the health page instead of blocking the feed. */
  quarantine: defineTable({
    hostId: v.string(),
    seq: v.number(),
    type: v.string(),
    userId: v.string(),
    reason: v.string(),
    at: v.number(),
  }).index('by_host', ['hostId', 'seq']),

  auditLog: defineTable({
    actor: v.object({ kind: v.union(v.literal('user'), v.literal('agent'), v.literal('system')), id: v.string() }),
    action: v.string(),
    target: v.optional(v.string()),
    at: v.number(),
  }).index('by_at', ['at']),
})
