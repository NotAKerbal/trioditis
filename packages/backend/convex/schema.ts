import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import {
  chatKind,
  deliveryState,
  envelope,
  errorCode,
  loginState,
  loginStep,
  network,
  sender,
  storedChatView,
  storedCommandPayload,
  storedLastMessage,
  storedNetwork,
  updateChannel,
  updateRequest,
  updaterReport,
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
    /**
     * The highest revision any of the person's key backups has had. Each new or replaced
     * backup takes the next one, so a revision is never reused, even for a passkey backup
     * removed and made again.
     */
    backupRevision: v.optional(v.number()),
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

  /**
   * How the server updates itself, in one row (`key: 'server'`): the release channel and
   * whether updates install on their own, which admins choose, an admin's request the updater
   * hasn't finished, and what the updater on the host last reported. See updates.ts.
   */
  serverUpdates: defineTable({
    key: v.literal('server'),
    channel: updateChannel,
    autoUpdate: v.boolean(),
    request: v.optional(updateRequest),
    updater: v.optional(updaterReport),
  }).index('by_key', ['key']),

  /**
   * The networks admins have installed, one row per network an admin (or the migration that
   * kept what an older version offered) has decided on. A network with no row isn't installed;
   * removing one keeps its row, with `installed: false`, so the decision stands.
   */
  serverNetworks: defineTable({
    network,
    installed: v.boolean(),
    updatedAt: v.number(),
    /** The admin who decided, or `migration`. */
    updatedBy: v.string(),
  }).index('by_network', ['network']),

  /**
   * Better Auth's rate limits, one token bucket per key (see rateLimits.ts). `key` is a
   * SHA-256, never the client address or email it was made from. A row whose bucket has
   * refilled (`fullAt` passed) means the same as no row, and is pruned.
   */
  rateLimits: defineTable({
    key: v.string(),
    tokens: v.number(),
    updatedAt: v.number(),
    fullAt: v.number(),
  })
    .index('by_key', ['key'])
    .index('by_fullAt', ['fullAt']),

  /** One connected account on one network, e.g. Isaac's WhatsApp. */
  networkAccounts: defineTable({
    userId: v.string(),
    network: storedNetwork,
    loginId: v.string(),
    /** The bridge host that runs this login; its commands go there. */
    hostId: v.optional(v.string()),
    /** When that host last took the login over (bridge host time). */
    hostSince: v.optional(v.number()),
    state: loginState,
    error: v.optional(errorCode),
    lastHealthyAt: v.optional(v.number()),
    updatedAt: v.number(),
    /** A logout was asked for and hasn't been confirmed yet. */
    logoutPending: v.optional(v.boolean()),
    /** The command of that pending logout: only its own outcome or timeout ends it. */
    logoutCommandId: v.optional(v.id('outbox')),
    /** Why the last logout didn't happen. */
    logoutError: v.optional(errorCode),
  })
    .index('by_user', ['userId'])
    .index('by_login', ['network', 'loginId']),

  loginSessions: defineTable({
    userId: v.string(),
    network: storedNetwork,
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
    /** The step input was last sent for: each step takes one submission, as the bridge host does. */
    submittedStepId: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  chats: defineTable({
    userId: v.string(),
    network: storedNetwork,
    loginId: v.string(),
    portalId: v.string(),
    kind: chatKind,
    /** Name, topic and avatar. Missing until the bridge host has described the chat. */
    sealedMeta: v.optional(envelope),
    parentPortalId: v.optional(v.string()),
    lastMessageAt: v.number(),
    /**
     * The newest message, as `messages.list` orders them, so the chat list can show it
     * without reading any message. Kept by lib/lastMessage.ts on every write that changes
     * which message that is, or what it says. `null` when the chat has no messages; missing on
     * a chat from before it was kept, until `migrations.backfillChatLast` reaches it.
     */
    last: v.optional(v.union(v.null(), storedLastMessage)),
    unreadCount: v.number(),
    pinned: v.boolean(),
    archived: v.boolean(),
    mutedUntil: v.optional(v.number()),
    deleted: v.optional(v.boolean()),
    /** Unread messages the bridge host flagged as mentioning the person. */
    mentionCount: v.optional(v.number()),
    /** Marked unread by the person, whatever the count says. Trioditis-side only. */
    markedUnread: v.optional(v.boolean()),
    /** Hidden from the inbox until then, or until a new message wakes it. */
    snoozedUntil: v.optional(v.number()),
    woke: v.optional(v.boolean()),
    /** A message request the person hasn't accepted. */
    isRequest: v.optional(v.boolean()),
    /** Hidden by the person. Trioditis-side only; the network isn't told yet. */
    blocked: v.optional(v.boolean()),
    /**
     * Which list the chat is in, kept by `lib/chatView.ts` on every write so the lists are
     * index ranges; `deleted` for a deleted chat, which is in none. Required, so a backend
     * holding chats from before views existed refuses this schema rather than hide them.
     */
    view: storedChatView,
  })
    .index('by_user_lastMessage', ['userId', 'lastMessageAt'])
    // Descending, `pinned: true` sorts before `false`: one range gives the pins, then the rest.
    .index('by_user_view_pinned_last', ['userId', 'view', 'pinned', 'lastMessageAt'])
    .index('by_user_view_network_pinned_last', ['userId', 'view', 'network', 'pinned', 'lastMessageAt'])
    .index('by_portal', ['userId', 'network', 'portalId']),

  /**
   * The person's own labels for chats. Name and colour are sealed to the person (kind
   * `label`, object ID `labelKey`, which the client chooses before sealing).
   */
  labels: defineTable({
    userId: v.string(),
    labelKey: v.string(),
    sealed: envelope,
    createdAt: v.number(),
  }).index('by_user', ['userId']),

  chatLabels: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    labelId: v.id('labels'),
  })
    .index('by_chat', ['chatId'])
    .index('by_label', ['labelId']),

  preferences: defineTable({
    userId: v.string(),
    sidebarLayout: v.union(v.literal('focused'), v.literal('simple')),
  }).index('by_user', ['userId']),

  /**
   * The identity private key, wrapped for new devices (docs/architecture/client-api.md, Keys).
   * Never unwrapped here: the server can't open any of these.
   */
  keyBackups: defineTable({
    userId: v.string(),
    kid: v.string(),
    kind: v.union(v.literal('password'), v.literal('recovery'), v.literal('passkey')),
    nonce: v.string(),
    ct: v.string(),
    /** For `password`: how the password becomes the wrapping key. */
    params: v.optional(
      v.object({ alg: v.literal('argon2id13'), salt: v.string(), opslimit: v.number(), memlimit: v.number() }),
    ),
    /** For `passkey`: which credential, and its PRF salt. */
    credentialId: v.optional(v.string()),
    prfSalt: v.optional(v.string()),
    /**
     * Changes each time this backup is replaced, never to a value it had before (see
     * `members.backupRevision`); a replacement names the one it replaces.
     */
    revision: v.number(),
    createdAt: v.number(),
  }).index('by_user', ['userId', 'kind']),

  /**
   * Proofs that a device holds the identity private key: a random challenge, sealed to the
   * public key for the device to open. Only its hash is kept, for five minutes, and it works
   * once.
   */
  keyChallenges: defineTable({
    userId: v.string(),
    hash: v.string(),
    /** The public key it was sealed to: a proof counts only for that key. */
    publicKey: v.string(),
    expiresAt: v.number(),
  }).index('by_user', ['userId']),

  /**
   * Messages to send later. At `sendAt` each becomes an ordinary send in the outbox. Until
   * then the bridge-readable copy waits here, and is deleted when it goes out or is cancelled.
   */
  scheduledSends: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    clientMessageId: v.string(),
    sendAt: v.number(),
    /** `failed` when its time came and its chat was gone: it was never sent. */
    state: v.union(v.literal('scheduled'), v.literal('sent'), v.literal('cancelled'), v.literal('failed')),
    replyTo: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_user', ['userId', 'state', 'sendAt'])
    .index('by_chat', ['chatId', 'state'])
    .index('by_clientMessageId', ['userId', 'clientMessageId']),

  /**
   * A scheduled message's sealed copies, kept apart so listing and counting scheduled
   * messages never reads them. Deleted when the message goes out or is cancelled.
   */
  scheduledPayloads: defineTable({
    scheduledId: v.id('scheduledSends'),
    forBridge: envelope,
    copy: envelope,
  }).index('by_scheduled', ['scheduledId']),

  contacts: defineTable({
    userId: v.string(),
    network: storedNetwork,
    ghostId: v.string(),
    sealedProfile: envelope,
  }).index('by_ghost', ['userId', 'network', 'ghostId']),

  messages: defineTable({
    userId: v.string(),
    chatId: v.id('chats'),
    network: storedNetwork,
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
    /** The bridge host flagged it as mentioning the person. */
    mentionsMe: v.optional(v.boolean()),
    /** For the person's own sends. */
    delivery: v.optional(deliveryState),
    sentByAgentId: v.optional(v.string()),
  })
    .index('by_event', ['userId', 'network', 'eventId'])
    .index('by_chat_sort', ['chatId', 'sortKey'])
    // Newest arrivals first (the index ends in `_creationTime`), without imported history,
    // for notifications (`messages.arrivals`).
    .index('by_user_live', ['userId', 'historical'])
    .index('by_clientMessageId', ['userId', 'clientMessageId']),

  reactions: defineTable({
    userId: v.string(),
    /** The message's chat, so a lookup by chat needn't read the (large) message row. */
    chatId: v.id('chats'),
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
  })
    .index('by_message', ['messageId', 'senderKey', 'key'])
    // Active reactions are the ones without `removedAt`: the hot path never reads tombstones.
    .index('by_message_active', ['messageId', 'removedAt']),

  /**
   * A deleted message whose reactions are still being removed (in batches, by
   * `cleanup.reactionsOfMessage`). `messages.reactions` shows none for it meanwhile, without
   * reading the message row, which can be large.
   */
  reactionCleanups: defineTable({
    messageId: v.id('messages'),
    /** The message's chat, so a query for another chat isn't told the message is deleted. */
    chatId: v.optional(v.id('chats')),
  }).index('by_message', ['messageId']),

  /** Every reaction event applied, so a replay of any of them changes nothing. */
  reactionEvents: defineTable({
    userId: v.string(),
    network: storedNetwork,
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
  })
    .index('by_chat_sender', ['chatId', 'senderKey'])
    .index('by_chat_expires', ['chatId', 'expiresAt']),

  /**
   * Commands for the bridge host. Each row's ID is the command's `commandId`, so the bridge
   * host runs a command once however often it is delivered.
   */
  outbox: defineTable({
    userId: v.string(),
    network: storedNetwork,
    loginId: v.optional(v.string()),
    /** Commands for one chat go out in order, one at a time. */
    chatId: v.optional(v.id('chats')),
    payload: storedCommandPayload,
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
    /**
     * `gateway.commandDeadline` is scheduled for it. Set when it is queued;
     * `migrations.scheduleCommandDeadlines` schedules one for rows from before that.
     */
    deadlineScheduled: v.optional(v.boolean()),
  })
    // Queued commands go out in creation order (`_creationTime`); `by_lease` finds claimed
    // ones by deadline. Both orders are needed.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index('by_state', ['state'])
    .index('by_lease', ['state', 'leaseUntil'])
    .index('by_expiry', ['state', 'expiresAt'])
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

  /** Where the last command claim stopped scanning, so the next one carries on from there. */
  claimCursor: defineTable({
    key: v.union(v.literal('queued'), v.literal('leases')),
    after: v.number(),
    /** For `leases`: the creation time of the last row at `after`, so rows sharing a deadline aren't skipped. */
    afterCreation: v.optional(v.number()),
  }).index('by_key', ['key']),

  /** Each bridge host's position in its event journal. */
  bridgeHosts: defineTable({
    hostId: v.string(),
    network: storedNetwork,
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
