import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import {
  chatKind,
  commandPayload,
  deliveryState,
  envelope,
  errorCode,
  loginState,
  loginStep,
  network,
  sender,
} from './validators'

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
    /** Held for one sign-up while Better Auth creates the account, so two can't both redeem it. */
    reservedUntil: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.string()),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_email', ['email']),

  /** Server-wide state. `setup` holds the first-admin sign-up while it is in progress. */
  serverState: defineTable({
    key: v.literal('setup'),
    reservedUntil: v.number(),
    reservedEmail: v.string(),
  }).index('by_key', ['key']),

  /** One connected account on one network, e.g. Isaac's WhatsApp. */
  networkAccounts: defineTable({
    userId: v.string(),
    network,
    loginId: v.string(),
    /** The bridge host that runs this login; its commands go there. */
    hostId: v.optional(v.string()),
    state: loginState,
    error: v.optional(errorCode),
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
    /** The bridge host running the login; its later steps must go there. */
    hostId: v.optional(v.string()),
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
    /** The latest event that added it, and when the bridge host saw it. */
    eventId: v.string(),
    addedAt: v.number(),
    networkTs: v.number(),
    /** Kept as a tombstone rather than deleted, for the same reason. */
    removedAt: v.optional(v.number()),
  }).index('by_message', ['messageId', 'senderKey', 'key']),

  /** Every reaction event applied, so a replay of any of them changes nothing. */
  reactionEvents: defineTable({
    userId: v.string(),
    network,
    eventId: v.string(),
  }).index('by_event', ['userId', 'network', 'eventId']),

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
   * host runs a command once however often it is delivered.
   */
  outbox: defineTable({
    userId: v.string(),
    network,
    loginId: v.optional(v.string()),
    /** Commands for one chat go out in order, one at a time. */
    chatId: v.optional(v.id('chats')),
    payload: commandPayload,
    /**
     * `queued` → `claimed` (leased to the gateway) → `dispatched` (the bridge host has it) or
     * `rejected` or `expired`.
     */
    state: v.union(
      v.literal('queued'),
      v.literal('claimed'),
      v.literal('dispatched'),
      v.literal('rejected'),
      v.literal('expired'),
    ),
    leaseUntil: v.optional(v.number()),
    /** Increases with every claim; a result for an older claim is ignored. */
    attempts: v.number(),
    /**
     * The bridge host it was first delivered to. Once delivery may have happened, only that
     * host (whose journal knows the command ID) may receive it again.
     */
    hostId: v.optional(v.string()),
    lastError: v.optional(errorCode),
    /** For sends: where the message is. Never reset to `queued` by an ambiguous outcome. */
    delivery: v.optional(deliveryState),
    clientMessageId: v.optional(v.string()),
    createdAt: v.number(),
    /** A send can't go out after this; it asks the person instead. */
    expiresAt: v.optional(v.number()),
  })
    // Queued commands go out in creation order (`_creationTime`); `by_lease` finds claimed
    // ones by deadline. Both orders are needed.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index('by_state', ['state'])
    .index('by_lease', ['state', 'leaseUntil'])
    .index('by_chat', ['chatId', 'state'])
    .index('by_clientMessageId', ['userId', 'clientMessageId']),

  /**
   * The bridge-readable part of a command (a message or login input, sealed to the bridge
   * key), kept apart so scanning the outbox never reads it. Deleted as soon as the bridge host
   * has accepted the command, or it is rejected or expires, so old outgoing messages and
   * credentials don't sit in the database or its backups.
   */
  outboxPayloads: defineTable({
    commandId: v.id('outbox'),
    sealed: envelope,
  }).index('by_command', ['commandId']),

  /** Each bridge host's position in its event journal. */
  bridgeHosts: defineTable({
    hostId: v.string(),
    network,
    lastSeq: v.number(),
    /** The last batch or heartbeat. Commands only go to hosts heard from recently. */
    lastSeenAt: v.number(),
  }).index('by_hostId', ['hostId']),

  /**
   * Events that couldn't be applied, kept for the health page instead of blocking the feed.
   * Only codes and IDs: never the event's content.
   */
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
