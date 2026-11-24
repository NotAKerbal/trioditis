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
    /**
     * The address book's count and revision from before they moved to `addressBooks`: still
     * read for a person whose address book hasn't changed since, never written.
     */
    peopleCount: v.optional(v.number()),
    peopleRevision: v.optional(v.number()),
    /**
     * Goes up whenever the sign-in password changes (a change or a reset). A password sign-in
     * notes it before checking the password, and its new session is ended if it moved meanwhile:
     * so a sign-in with the old password that races a reset never keeps a session.
     */
    credentialVersion: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_userId', ['userId']),

  /**
   * Members an admin removed whose network accounts may still be signed in on a bridge host. Kept
   * until every one of their accounts reports LOGGED_OUT, so an admin can see the cleanup and try
   * it again (members.removedCleanup, members.retryCleanup). Holds no content.
   */
  removedMembers: defineTable({
    userId: v.string(),
    email: v.optional(v.string()),
    removedBy: v.string(),
    removedAt: v.number(),
    /** Some of their accounts aren't logged out yet. Only these are listed (`by_active`). */
    active: v.optional(v.boolean()),
  })
    .index('by_user', ['userId'])
    .index('by_active', ['active', 'removedAt']),

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

  /**
   * Password resets an admin issued (members.issuePasswordReset), each for one member, used once
   * with the member's recovery key (account.resetPassword).
   */
  passwordResets: defineTable({
    userId: v.string(),
    /** SHA-256 of the token in the reset link. The token itself is never stored. */
    tokenHash: v.string(),
    issuedBy: v.string(),
    expiresAt: v.number(),
  })
    .index('by_tokenHash', ['tokenHash'])
    .index('by_user', ['userId']),

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
   * Google Contacts (google.ts), in one row (`key: 'contacts'`): the OAuth client ID an admin
   * set up in Google Cloud, which people's apps sign in to Google with to read their contacts
   * themselves. A client ID isn't a secret: Google shows it on every sign-in page.
   */
  serverGoogle: defineTable({
    key: v.literal('contacts'),
    clientId: v.string(),
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index('by_key', ['key']),

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
    /** What the bridge host last said tells the account apart, sealed to its owner (kind `account`, object ID `loginId`). */
    sealedMeta: v.optional(envelope),
    /**
     * A login the person cancelled connected it anyway. Kept until they decide (logins.keep, or a
     * disconnect), and cleared by any normal login of the account.
     */
    connectedAfterCancel: v.optional(v.boolean()),
    /** A logout was asked for and hasn't been confirmed yet. */
    logoutPending: v.optional(v.boolean()),
    /** The command of that pending logout: only its own outcome or timeout ends it. */
    logoutCommandId: v.optional(v.id('outbox')),
    /** Why the last logout didn't happen. */
    logoutError: v.optional(errorCode),
    /** When the person last asked for this login's contact list (contacts.sync). */
    contactsSyncedAt: v.optional(v.number()),
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
  })
    .index('by_user', ['userId'])
    .index('by_network_state', ['network', 'state']),

  /**
   * Tickets to a login step's sign-in browser (docs/architecture/signin-browser.md). Only the
   * ticket's SHA-256 is kept; the gateway redeems a ticket once, within a minute.
   */
  signinTickets: defineTable({
    tokenHash: v.string(),
    loginSessionId: v.id('loginSessions'),
    userId: v.string(),
    hostId: v.string(),
    stepId: v.string(),
    expiresAt: v.number(),
  })
    .index('by_token', ['tokenHash'])
    .index('by_user', ['userId']),

  chats: defineTable({
    userId: v.string(),
    network: storedNetwork,
    loginId: v.string(),
    portalId: v.string(),
    kind: chatKind,
    /** Name, topic and avatar. Missing until the bridge host has described the chat. */
    sealedMeta: v.optional(envelope),
    /** The members whose pictures make a group's picture (chatCollage events), sealed apart. */
    sealedCollage: v.optional(envelope),
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
    /** One more with every message counted unread (`ChatRow.unreadRev`). */
    unreadRev: v.optional(v.number()),
    pinned: v.boolean(),
    archived: v.boolean(),
    mutedUntil: v.optional(v.number()),
    deleted: v.optional(v.boolean()),
    /** Unread messages the bridge host flagged as mentioning the person. */
    mentionCount: v.optional(v.number()),
    /** Marked unread by the person, whatever the count says. Trioditis-side only. */
    markedUnread: v.optional(v.boolean()),
    /**
     * The `sortKey` of the newest message the person is known to have read, here (mark read)
     * or elsewhere (their own read receipt). It only moves forward, so a message that arrives
     * late but sorts at or before it doesn't count as unread.
     */
    readSortKey: v.optional(v.string()),
    /**
     * The `sortKey` of the newest message someone else's read receipt has covered. Only moves
     * forward. The person's own messages up to it are `read`, including one that arrives late.
     */
    theirReadSortKey: v.optional(v.string()),
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
    // The same lists by recency alone, pinned or not (chats.list, `order: 'recent'`).
    .index('by_user_view_last', ['userId', 'view', 'lastMessageAt'])
    .index('by_user_view_network_last', ['userId', 'view', 'network', 'lastMessageAt'])
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

  /**
   * The person's address book: one card per person they know, which can link that person's
   * contacts on several networks. Everything on a card is sealed to the person (kind `person`,
   * object ID `personKey`, which the client chooses before sealing); see client-api.md, People.
   */
  /**
   * A request to start a chat (newChats.start), until the bridge host answers with the chat
   * or why there's none. The identifier it was for is sealed to the bridge key and goes with
   * the command; none of it is kept here.
   */
  chatStarts: defineTable({
    userId: v.string(),
    network: storedNetwork,
    loginId: v.string(),
    /** Picked by the client, as the sealed identifier's object ID. */
    requestId: v.string(),
    commandId: v.id('outbox'),
    state: v.union(v.literal('pending'), v.literal('started'), v.literal('failed')),
    chatId: v.optional(v.id('chats')),
    error: v.optional(errorCode),
    createdAt: v.number(),
  })
    .index('by_request', ['userId', 'requestId'])
    .index('by_command', ['commandId'])
    .index('by_user_createdAt', ['userId', 'createdAt'])
    .index('by_createdAt', ['createdAt']),

  /**
   * The person's address book (`people`): how many cards it has, kept by people.ts for its cap,
   * and its revision, which goes up with every change. Each write names the revision it was
   * made from, so two devices can't both link one contact to different cards. Apart from the
   * person's `members` row, which every query reads to check membership: kept there, each card
   * saved ran all of the person's queries again.
   */
  addressBooks: defineTable({
    userId: v.string(),
    count: v.number(),
    revision: v.number(),
  }).index('by_user', ['userId']),

  people: defineTable({
    userId: v.string(),
    personKey: v.string(),
    sealed: envelope,
    updatedAt: v.number(),
  }).index('by_user', ['userId', 'personKey']),

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
   * then the sealed copies wait in `scheduledPayloads`, deleted when it goes out. A cancelled
   * one keeps them, so its text can go back to the person's composer, until they discard it
   * (`scheduled.forget`, `forgottenAt` set) or 30 days pass.
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
    cancelledAt: v.optional(v.number()),
    /** A cancelled one whose copies are gone: restored to the composer, discarded, or expired. */
    forgottenAt: v.optional(v.number()),
  })
    .index('by_user', ['userId', 'state', 'sendAt'])
    .index('by_clientMessageId', ['userId', 'clientMessageId'])
    // Cancelled ones still holding their copies (`forgottenAt` unset), oldest first: forgotten
    // ones are kept, for their client message IDs, but never in the way of these.
    .index('by_user_kept', ['userId', 'state', 'forgottenAt', 'cancelledAt'])
    .index('by_chat_kept', ['chatId', 'state', 'forgottenAt', 'cancelledAt'])
    .index('by_kept', ['state', 'forgottenAt', 'cancelledAt']),

  /**
   * A scheduled message's sealed copies, kept apart so listing and counting scheduled
   * messages never reads them. Deleted when the message goes out, or when a cancelled one is
   * forgotten.
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
    /**
     * The accounts whose logins have sent the contact (at most 10): a chat with them starts on
     * one of those, since some networks' contact IDs belong to one login (Google Messages').
     */
    accountIds: v.optional(v.array(v.id('networkAccounts'))),
  }).index('by_ghost', ['userId', 'network', 'ghostId']),

  /**
   * What one of the person's logins knows a contact by (contactIdentifiers events), sealed to
   * the person. Its own table, one row per login and contact, so it never waits on the
   * contact's profile and two logins never overwrite each other.
   */
  contactIdentifiers: defineTable({
    userId: v.string(),
    network: storedNetwork,
    ghostId: v.string(),
    loginId: v.string(),
    sealed: envelope,
  }).index('by_contact', ['userId', 'network', 'ghostId', 'loginId']),

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
    /**
     * How many edits of it have arrived, for networks that cap them (NETWORK_INFO `maxEdits`).
     * Counted from when Trioditis began counting: an older message's earlier edits aren't in it.
     */
    edits: v.optional(v.number()),
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
    .index('by_message_active', ['messageId', 'removedAt'])
    // The same, only the person's own, for `messages.reactions` to read so that nothing of
    // anyone else's is in its read set. Staged: built in the background on an upgrade rather
    // than holding up the deploy on a large table. A later release switches to it.
    .index('by_user_message_active', { fields: ['userId', 'messageId', 'removedAt'], staged: true })
    // The person's own active reactions on a message, past the first 100 (`messages.reactions`).
    .index('by_message_sender_active', ['messageId', 'senderKey', 'removedAt']),

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
    /**
     * For a send made with `messages.sendAgain`: the original send's client message ID, the
     * attempt before it, and its place in the chain (1, 2…). See lib/retry.ts.
     */
    retryRoot: v.optional(v.string()),
    retryOf: v.optional(v.string()),
    retryIndex: v.optional(v.number()),
  })
    // Queued commands go out in creation order (`_creationTime`); `by_lease` finds claimed
    // ones by deadline. Both orders are needed.
    // eslint-disable-next-line @convex-dev/no-duplicate-indexes
    .index('by_state', ['state'])
    .index('by_lease', ['state', 'leaseUntil'])
    .index('by_expiry', ['state', 'expiresAt'])
    .index('by_chat', ['chatId', 'state'])
    .index('by_clientMessageId', ['userId', 'clientMessageId'])
    .index('by_retryRoot', ['userId', 'retryRoot', 'retryIndex']),

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
    /**
     * When its `bridgePressure` row was last written (0 once it stopped), so ingest knows when
     * the next is due without reading that row on every batch.
     */
    pressureAt: v.optional(v.number()),
  }).index('by_hostId', ['hostId']),

  /**
   * How each bridge host's deliveries are going, as it last said, written at most every 30
   * seconds (gateway.ingest), for Settings → Admin → Server health. Counts and times only.
   */
  bridgePressure: defineTable({
    hostId: v.string(),
    network: storedNetwork,
    /** Journal events the host hadn't had acknowledged yet. */
    backlog: v.number(),
    /** How long its last delivery took to be answered (ms). */
    pushMs: v.number(),
    /** Its deliveries that failed in the five minutes before. */
    failedPushes: v.number(),
    at: v.number(),
    /** The host said it was stopping: offline from `at`, not once it goes quiet. */
    stopped: v.optional(v.boolean()),
  }).index('by_hostId', ['hostId']),

  /**
   * The server timing its own answer to a small query, once a minute (health.probe): the last
   * hour's, in one row, for Settings → Admin → Server health.
   */
  serverProbes: defineTable({
    samples: v.array(v.object({ at: v.number(), ms: v.number(), ok: v.boolean() })),
  }),

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
  })
    .index('by_host', ['hostId', 'seq'])
    // Newest first, for the admin's list (quarantine.list).
    .index('by_at', ['at']),

  auditLog: defineTable({
    actor: v.object({ kind: v.union(v.literal('user'), v.literal('agent'), v.literal('system')), id: v.string() }),
    action: v.string(),
    target: v.optional(v.string()),
    at: v.number(),
  }).index('by_at', ['at']),
})
