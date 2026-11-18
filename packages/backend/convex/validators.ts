import { v, type Infer } from 'convex/values'
import { DELIVERY_STATES, NETWORKS } from '@trioditis/core'
import { ERROR_CODES, LOGIN_STATES } from '@trioditis/core/bridge-protocol'

// Validators shared by the schema and the functions. Wire shapes follow
// docs/architecture/bridge-protocol.md; sealed shapes follow docs/architecture/sealing.md.

export const network = v.union(...NETWORKS.map((name) => v.literal(name)))

/** A sealed object. Only ciphertext and recipients' key IDs; never plaintext. */
export const envelope = v.object({
  v: v.literal(1),
  nonce: v.string(),
  ct: v.string(),
  keys: v.array(v.object({ kid: v.string(), sk: v.string() })),
})

export const sender = v.union(v.object({ self: v.literal(true) }), v.object({ ghostId: v.string() }))

export const deliveryState = v.union(...DELIVERY_STATES.map((state) => v.literal(state)))

export const loginState = v.union(...LOGIN_STATES.map((state) => v.literal(state)))

/** Why something failed: a fixed code, never free text. See bridge-protocol.md, Errors. */
export const errorCode = v.union(...ERROR_CODES.map((code) => v.literal(code)))

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
    }),
  ),
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
  }),
  v.object({ ...base, type: v.literal('contact'), ghostId: v.string(), sealed: envelope }),
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
  v.object({
    type: v.literal('backfill'),
    portalId: v.string(),
    beforeEventId: v.optional(v.string()),
    limit: v.number(),
  }),
)
export type CommandPayload = Infer<typeof commandPayload>
