import { v, type Infer } from 'convex/values'
import { DELIVERY_STATES, NETWORKS } from '@trioditis/core'
import { ERROR_CODES, LOGIN_STATES } from '@trioditis/core/bridge-protocol'

// Validators shared by the schema and the functions. Wire shapes follow
// docs/architecture/bridge-protocol.md; sealed shapes follow docs/architecture/sealing.md.

export const network = v.union(...NETWORKS.map((name) => v.literal(name)))

/**
 * The network a stored row is on: a real one, or `fake`, a test network Trioditis no longer
 * has. Rows on it can only be deleted (migrations.purgeFakeNetwork), and the schema has to
 * accept them until every deployment has run that, since a schema its rows don't match won't
 * deploy. Its type is `network`'s, so nothing else handles `fake`: the purge runs right after
 * the deploy, and only it looks for those rows. Once every deployment has run it, this
 * becomes `network` again.
 */
export const storedNetwork = v.union(network, v.literal('fake')) as unknown as typeof network

/** A sealed object. Only ciphertext and recipients' key IDs; never plaintext. */
export const envelope = v.object({
  v: v.literal(1),
  nonce: v.string(),
  ct: v.string(),
  keys: v.array(v.object({ kid: v.string(), sk: v.string() })),
})

export const sender = v.union(v.object({ self: v.literal(true) }), v.object({ ghostId: v.string() }))

/**
 * A chat's pointer to its newest message, kept by lib/lastMessage.ts. `sealed` is that
 * message's latest content, kept only when it's small enough for the chat list.
 */
export const storedLastMessage = v.object({
  messageId: v.id('messages'),
  sortKey: v.string(),
  at: v.number(),
  self: v.boolean(),
  ghostId: v.optional(v.string()),
  redacted: v.boolean(),
  sealed: v.optional(envelope),
  objectId: v.string(),
})

export const deliveryState = v.union(...DELIVERY_STATES.map((state) => v.literal(state)))

export const loginState = v.union(...LOGIN_STATES.map((state) => v.literal(state)))

/** Why something failed: a fixed code, never free text. See bridge-protocol.md, Errors. */
export const errorCode = v.union(...ERROR_CODES.map((code) => v.literal(code)))

/** Which list a chat is in. See lib/chatView.ts. */
export const chatView = v.union(
  v.literal('inbox'),
  v.literal('snoozed'),
  v.literal('archived'),
  v.literal('requests'),
  v.literal('blocked'),
)

/** What a chat stores as its `view`: one of the lists, or `deleted`, which is in none. */
export const storedChatView = v.union(chatView, v.literal('deleted'))

export const chatKind = v.union(v.literal('dm'), v.literal('group'), v.literal('channel'), v.literal('space'))

export const loginStep = v.object({
  stepId: v.string(),
  type: v.union(
    v.literal('displayAndWait'),
    v.literal('userInput'),
    v.literal('cookies'),
    v.literal('complete'),
    v.literal('cancelled'),
    v.literal('error'),
  ),
  instructions: v.optional(v.string()),
  display: v.optional(
    v.object({
      type: v.union(v.literal('qr'), v.literal('code'), v.literal('emoji'), v.literal('nothing')),
      data: v.optional(v.string()),
      /** When to stop showing the code (ms); the bridge host moves it on while it's good. */
      expiresAt: v.optional(v.number()),
    }),
  ),
  /** When the step stops working (bridge host time, ms), where the network says. */
  expiresAt: v.optional(v.number()),
  fields: v.optional(
    v.array(
      v.object({
        id: v.string(),
        type: v.string(),
        name: v.string(),
        description: v.optional(v.string()),
        pattern: v.optional(v.string()),
      }),
    ),
  ),
  cookies: v.optional(
    v.object({
      url: v.string(),
      userAgent: v.optional(v.string()),
      fields: v.array(v.object({ id: v.string(), required: v.boolean() })),
      browser: v.optional(v.boolean()),
      hidden: v.optional(v.boolean()),
    }),
  ),
  loginId: v.optional(v.string()),
  error: v.optional(errorCode),
})

const base = { seq: v.number(), userId: v.string(), loginId: v.string(), at: v.number() }

export const bridgeEvent = v.union(
  v.object({
    ...base,
    type: v.literal('message'),
    portalId: v.string(),
    eventId: v.string(),
    networkTs: v.number(),
    sender,
    sealed: envelope,
    historical: v.boolean(),
    replyTo: v.optional(v.string()),
    threadRoot: v.optional(v.string()),
    clientMessageId: v.optional(v.string()),
    /** The message mentions the person: the bridge host can tell, as it sees the plaintext. */
    mentionsMe: v.optional(v.boolean()),
  }),
  v.object({
    ...base,
    type: v.literal('edit'),
    portalId: v.string(),
    eventId: v.string(),
    targetEventId: v.string(),
    networkTs: v.number(),
    sender,
    sealed: envelope,
    /** Set when the edit was made from Trioditis, so its outcome can be matched. */
    clientMessageId: v.optional(v.string()),
  }),
  v.object({
    ...base,
    type: v.literal('reaction'),
    portalId: v.string(),
    eventId: v.string(),
    targetEventId: v.string(),
    sender,
    key: v.string(),
    networkTs: v.number(),
  }),
  v.object({
    ...base,
    type: v.literal('reactionRemove'),
    portalId: v.string(),
    targetEventId: v.string(),
    sender,
    key: v.string(),
  }),
  v.object({
    ...base,
    type: v.literal('redaction'),
    portalId: v.string(),
    targetEventId: v.string(),
    sender,
    networkTs: v.number(),
  }),
  v.object({
    ...base,
    type: v.literal('receipt'),
    portalId: v.string(),
    sender,
    upToEventId: v.string(),
    networkTs: v.number(),
  }),
  v.object({
    ...base,
    type: v.literal('typing'),
    portalId: v.string(),
    sender,
    typing: v.boolean(),
    timeoutMs: v.number(),
  }),
  v.object({
    ...base,
    type: v.literal('chat'),
    portalId: v.string(),
    kind: chatKind,
    sealed: envelope,
    parentPortalId: v.optional(v.string()),
    deleted: v.optional(v.boolean()),
    /** The network says this chat is a message request the person hasn't accepted. */
    isRequest: v.optional(v.boolean()),
  }),
  v.object({ ...base, type: v.literal('contact'), ghostId: v.string(), sealed: envelope }),
  v.object({ ...base, type: v.literal('contactIdentifiers'), ghostId: v.string(), sealed: envelope }),
  v.object({
    ...base,
    type: v.literal('chatStarted'),
    requestId: v.string(),
    portalId: v.optional(v.string()),
    error: v.optional(errorCode),
  }),
  v.object({
    ...base,
    type: v.literal('loginState'),
    state: loginState,
    error: v.optional(errorCode),
  }),
  v.object({ ...base, type: v.literal('loginStep'), loginSessionId: v.string(), step: loginStep }),
  v.object({
    ...base,
    type: v.literal('sendStatus'),
    clientMessageId: v.string(),
    status: v.union(
      v.literal('submitted'),
      v.literal('sent'),
      v.literal('delivered'),
      v.literal('read'),
      v.literal('failed'),
      v.literal('unknown'),
    ),
    eventId: v.optional(v.string()),
    error: v.optional(errorCode),
  }),
  v.object({
    ...base,
    type: v.literal('backfillDone'),
    portalId: v.string(),
    direction: v.union(v.literal('backward'), v.literal('forward')),
    more: v.boolean(),
  }),
)
export type BridgeEventDoc = Infer<typeof bridgeEvent>

/**
 * What a queued command asks the bridge host to do. `commandId` is the outbox row's ID. The
 * bridge-readable part of a send, edit or login input is kept apart, in the outbox row's
 * `sealedPayload`, so it can be deleted as soon as the bridge host has it.
 */
export const commandPayload = v.union(
  v.object({
    type: v.literal('send'),
    portalId: v.string(),
    clientMessageId: v.string(),
    replyTo: v.optional(v.string()),
  }),
  v.object({
    type: v.literal('edit'),
    portalId: v.string(),
    targetEventId: v.string(),
    clientMessageId: v.string(),
  }),
  v.object({
    type: v.union(v.literal('react'), v.literal('unreact')),
    portalId: v.string(),
    targetEventId: v.string(),
    key: v.string(),
  }),
  v.object({ type: v.literal('redact'), portalId: v.string(), targetEventId: v.string() }),
  v.object({ type: v.literal('markRead'), portalId: v.string(), upToEventId: v.string() }),
  v.object({ type: v.literal('typing'), portalId: v.string(), typing: v.boolean() }),
  v.object({ type: v.literal('loginStart'), loginSessionId: v.string(), network, flowId: v.optional(v.string()) }),
  v.object({ type: v.literal('loginSubmit'), loginSessionId: v.string(), stepId: v.string() }),
  v.object({ type: v.literal('loginCancel'), loginSessionId: v.string() }),
  v.object({ type: v.literal('logout') }),
  v.object({ type: v.literal('syncContacts') }),
  v.object({ type: v.literal('startChat'), requestId: v.string(), ghostId: v.optional(v.string()) }),
  v.object({
    type: v.literal('backfill'),
    portalId: v.string(),
    beforeEventId: v.optional(v.string()),
    limit: v.number(),
  }),
)
export type CommandPayload = Infer<typeof commandPayload>

/** A stored command's payload: also a login on the fake network, until it's purged (`storedNetwork`). */
export const storedCommandPayload = v.union(
  commandPayload,
  v.object({
    type: v.literal('loginStart'),
    loginSessionId: v.string(),
    network: v.literal('fake'),
    flowId: v.optional(v.string()),
  }),
) as unknown as typeof commandPayload

/**
 * A release channel: `stable` follows the repository's `main` branch, `nightly` its `dev`
 * branch. The updater on the host maps each to its branch; see docs/deploy.md, Updates.
 */
export const updateChannel = v.union(v.literal('stable'), v.literal('nightly'))
export type UpdateChannel = Infer<typeof updateChannel>

/** An admin's request to the updater: look for a new version, or install it. */
export const updateRequest = v.object({
  id: v.string(),
  kind: v.union(v.literal('check'), v.literal('update')),
  at: v.number(),
  by: v.string(),
})

/** A commit of this repository, as the updater reports it. */
export const commitInfo = v.object({ commit: v.string(), committedAt: v.number() })

/**
 * One line of a release note: what a change does for the people using the server, with its
 * label. Each pull request writes its own (release-notes/, docs/CONTRIBUTING.md), and the
 * updater collects those an update brings.
 */
export const releaseNote = v.object({
  label: v.union(
    v.literal('new'),
    v.literal('improved'),
    v.literal('fixed'),
    v.literal('security'),
    v.literal('internal'),
  ),
  text: v.string(),
})
export type ReleaseNote = Infer<typeof releaseNote>

/** What the updater on the host last said. */
export const updaterReport = v.object({
  seenAt: v.number(),
  state: v.union(v.literal('idle'), v.literal('checking'), v.literal('updating'), v.literal('failed')),
  /** A short, plain-language note for the admin, such as why an update failed. */
  message: v.optional(v.string()),
  /** When the update in progress (or the one that failed) started. */
  startedAt: v.optional(v.number()),
  /** The commit this server runs. */
  current: v.optional(commitInfo),
  /**
   * The newest commit on `channel`'s branch when the updater last looked (`checkedAt`), and
   * how far it is from `current`: commits it has that the server doesn't (`behind`), and the
   * other way round (`ahead`). Only an update with nothing ahead installs.
   */
  latest: v.optional(
    v.object({
      channel: updateChannel,
      commit: v.string(),
      committedAt: v.number(),
      subject: v.string(),
      /** The release notes of the commits it has that `current` doesn't. */
      notes: v.optional(v.array(releaseNote)),
      behind: v.number(),
      ahead: v.number(),
      checkedAt: v.number(),
    }),
  ),
  /**
   * The last update that went in, from commit `from` to `to`, when (`at`), and its release
   * notes: what admins see as what's new while the server still runs `to`.
   */
  installed: v.optional(v.object({ from: v.string(), to: v.string(), at: v.number(), notes: v.array(releaseNote) })),
})
export type UpdaterReport = Infer<typeof updaterReport>
