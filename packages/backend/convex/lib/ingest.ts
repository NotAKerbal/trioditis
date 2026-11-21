import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { BridgeEventDoc } from '../validators'
import type { Network } from '@trioditis/core'
import { isEnvelope } from './envelope'
import { deletePayload, queueLogout } from './outbox'
import { removedNetwork } from './networks'
import { patchChat } from './chatView'
import { onLoggedOut } from './commandOutcome'
import { internal } from '../_generated/api'
import { MAX_MESSAGE_ROW_BYTES, byteSize } from './bounded'
import { noteMessage } from './lastMessage'

// Applying one bridge host event to the tables. See docs/architecture/bridge-protocol.md.
// Every write is keyed so replaying an event changes nothing: the bridge host delivers at
// least once.
//
// An event that can't be applied throws `Unmappable` before it writes anything, so the
// caller can quarantine it without leaving half of it applied (a caught error doesn't roll
// back earlier writes in the same mutation).

/**
 * Why an event can't be applied. Quarantine keeps only this code, never the event's content.
 */
export type UnmappableReason =
  | 'missing_target'
  | 'missing_chat'
  | 'foreign_login'
  | 'foreign_host'
  | 'unknown_login_session'
  | 'unknown_send'
  | 'malformed_envelope'
  | 'too_large'
  | 'unknown_chat_start'

/** An event that can't be applied. Quarantined rather than blocking the feed. */
export class Unmappable extends Error {
  readonly reason: UnmappableReason
  constructor(reason: UnmappableReason) {
    super(reason)
    this.reason = reason
  }
}

/** Where an event came from. */
export interface Origin {
  network: Network
  hostId: string
}

/**
 * Roughly how many bytes an ingest call has read and written so far. Message, chat and contact
 * rows can each hold up to two sealed objects, so a batch of small events (edits, reactions)
 * can still touch many large rows. The caller stops a batch early once this passes its budget
 * and acknowledges what it applied, so no call can exceed Convex's transaction limits.
 */
const meters = new WeakMap<MutationCtx, { bytes: number }>()

export function startMeter(ctx: MutationCtx) {
  const meter = { bytes: 0 }
  meters.set(ctx, meter)
  return meter
}

/** Counts a row read and, as most are, rewritten. */
function charge<T>(ctx: MutationCtx, doc: T): T {
  const meter = meters.get(ctx)
  if (meter && doc) meter.bytes += 2 * byteSize(doc)
  return doc
}

type Sender = Extract<BridgeEventDoc, { type: 'message' }>['sender']
type Delivery = NonNullable<Doc<'messages'>['delivery']>

export function senderKey(sender: Sender): string {
  return 'self' in sender ? 'self' : `ghost:${sender.ghostId}`
}

/** Network time, zero-padded so strings sort like numbers, then the event ID to break ties. */
export function sortKey(networkTs: number, eventId: string): string {
  return `${Math.max(0, Math.floor(networkTs)).toString().padStart(16, '0')}:${eventId}`
}

async function findChat(ctx: MutationCtx, userId: string, network: Network, portalId: string) {
  return charge(ctx, await findChatRow(ctx, userId, network, portalId))
}

async function findChatRow(ctx: MutationCtx, userId: string, network: Network, portalId: string) {
  return await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', network).eq('portalId', portalId))
    .unique()
}

/**
 * The chat for a portal, created bare if the bridge host hasn't described it yet. Its
 * `chat` event fills it in when it comes.
 */
export async function chatFor(
  ctx: MutationCtx,
  event: { userId: string; loginId: string; portalId: string },
  network: Network,
) {
  const existing = await findChat(ctx, event.userId, network, event.portalId)
  if (existing) return existing
  const chatId = await ctx.db.insert('chats', {
    userId: event.userId,
    network,
    loginId: event.loginId,
    portalId: event.portalId,
    kind: 'dm',
    lastMessageAt: 0,
    last: null,
    unreadCount: 0,
    pinned: false,
    archived: false,
    view: 'inbox',
  })
  return (await ctx.db.get(chatId))!
}

async function findMessage(ctx: MutationCtx, userId: string, network: Network, eventId: string) {
  return charge(
    ctx,
    await ctx.db
      .query('messages')
      .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', network).eq('eventId', eventId))
      .unique(),
  )
}

async function targetMessage(ctx: MutationCtx, userId: string, network: Network, eventId: string) {
  const message = await findMessage(ctx, userId, network, eventId)
  if (!message) throw new Unmappable('missing_target')
  return message
}

async function findOutboxSend(ctx: MutationCtx, userId: string, clientMessageId: string) {
  return await ctx.db
    .query('outbox')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
}

/**
 * The send `clientMessageId` names, if the reporting host is the one it went to. A report
 * about another host's send must not settle it or delete its payload.
 */
async function sendFrom(ctx: MutationCtx, userId: string, clientMessageId: string, origin: Origin) {
  const send = await findOutboxSend(ctx, userId, clientMessageId)
  if (!send) return null
  // A send is pinned to a host when first handed out; before that no host can have it.
  if (send.network !== origin.network || send.hostId !== origin.hostId) return null
  return send
}

async function findPersonsCopy(ctx: MutationCtx, userId: string, clientMessageId: string) {
  return charge(
    ctx,
    await ctx.db
      .query('messages')
      .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
      .first(),
  )
}

const DELIVERY_ORDER: Record<Delivery, number> = {
  queued: 0,
  claimed: 1,
  submitted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  unknown: 6,
}

/**
 * Delivery only moves forward, so a late `submitted` can't undo `delivered`. An outcome the
 * bridge host reports later settles an unknown one: it knows whether it handed the message to
 * the network. A confirmation that the network has it also overrides a failure.
 */
export function advance(current: Doc<'messages'>['delivery'], next: Delivery): Delivery {
  if (!current) return next
  const confirmed = next === 'sent' || next === 'delivered' || next === 'read'
  if (current === 'unknown') return confirmed || next === 'failed' ? next : current
  if (current === 'failed') return confirmed ? next : current
  return DELIVERY_ORDER[next] > DELIVERY_ORDER[current] ? next : current
}

/**
 * A status or echo for a send proves the bridge host has the command, even if its 202 never
 * reached the gateway. Settling the outbox row means it is never delivered again, and its
 * bridge-readable payload is deleted.
 */
async function settleSend(ctx: MutationCtx, send: Doc<'outbox'>, delivery: Delivery) {
  const pending = send.state === 'queued' || send.state === 'claimed'
  await ctx.db.patch(send._id, {
    delivery: advance(send.delivery, delivery),
    ...(pending ? { state: 'dispatched' as const, leaseUntil: undefined } : {}),
  })
  charge(ctx, await deletePayload(ctx, send._id))
}

async function applyMessage(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'message' }>, origin: Origin) {
  const { network } = origin
  if (await findMessage(ctx, event.userId, network, event.eventId)) return
  // The echo of a send from Trioditis must come from the host the send went to. One from
  // anywhere else is refused before anything is written, so the right host's echo, with the
  // same event ID, can still settle it.
  const clientMessageId = 'self' in event.sender ? event.clientMessageId : undefined
  const send = clientMessageId ? await sendFrom(ctx, event.userId, clientMessageId, origin) : null
  if (clientMessageId && !send && (await findOutboxSend(ctx, event.userId, clientMessageId))) {
    throw new Unmappable('foreign_host')
  }
  const chat = await chatFor(ctx, event, network)
  const fields = {
    eventId: event.eventId,
    networkTs: event.networkTs,
    sortKey: sortKey(event.networkTs, event.eventId),
    sender: event.sender,
    sealed: event.sealed,
    sealedObjectId: event.eventId,
    historical: event.historical,
    // Kept so a read receipt can recount mentions among the messages after it.
    ...(event.mentionsMe && !('self' in event.sender) ? { mentionsMe: true } : {}),
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.threadRoot ? { threadRoot: event.threadRoot } : {}),
  }

  // The echo of a send from Trioditis replaces the person's pending copy: only a copy still
  // pending, of their own message, in this chat, echoed by the host the send went to.
  // Anything else is stored as a new message.
  const pending = clientMessageId ? await findPersonsCopy(ctx, event.userId, clientMessageId) : null
  // Either way the chat's pointer to its newest message is kept: an echo keeps the pending
  // copy's ID but can change its time, and so its place.
  // The person's own message that arrives after someone's read receipt covering its place was
  // read with the rest.
  const readByThem =
    'self' in event.sender && chat.theirReadSortKey !== undefined && fields.sortKey <= chat.theirReadSortKey
  if (pending && send && pending.chatId === chat._id && pending.eventId.startsWith('pending:')) {
    await ctx.db.patch(pending._id, { ...fields, delivery: advance(pending.delivery, readByThem ? 'read' : 'sent') })
    await settleSend(ctx, send, 'sent')
    charge(ctx, await noteMessage(ctx, chat, { ...pending, ...fields }))
  } else {
    const messageId = await ctx.db.insert('messages', {
      userId: event.userId,
      chatId: chat._id,
      network,
      ...fields,
      ...(readByThem ? { delivery: 'read' as const } : {}),
    })
    charge(ctx, await noteMessage(ctx, chat, { _id: messageId, ...fields }))
  }

  // Imported history neither notifies, counts as unread, nor reorders the inbox.
  if (event.historical) return
  // A message that arrives late, but sorts at or before what the person has already read, was
  // read with the rest: it doesn't count as unread or as a mention.
  const fromSomeoneElse = !('self' in event.sender) && !readAlready(chat, fields.sortKey)
  await patchChat(ctx, chat, {
    lastMessageAt: Math.max(chat.lastMessageAt, event.networkTs),
    ...(fromSomeoneElse
      ? {
          unreadCount: chat.unreadCount + 1,
          ...(event.mentionsMe ? { mentionCount: (chat.mentionCount ?? 0) + 1 } : {}),
          // A new message wakes a snoozed chat early.
          ...(chat.snoozedUntil !== undefined && !chat.woke ? { woke: true } : {}),
        }
      : {}),
  })
}

async function applyEdit(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'edit' }>, network: Network) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  // A deleted message stays deleted, whatever edit arrives after.
  if (message.redactedAt !== undefined) return
  if (message.editedAt !== undefined && message.editedAt >= event.networkTs) return
  const edit = { sealedEdit: event.sealed, editEventId: event.eventId, editedAt: event.networkTs }
  await ctx.db.patch(message._id, edit)
  await noteChanged(ctx, { ...message, ...edit })
}

/** Keeps the pointer of a changed message's chat, which the change may be the newest of. */
async function noteChanged(ctx: MutationCtx, message: Doc<'messages'>) {
  const chat = charge(ctx, await ctx.db.get(message.chatId))
  if (chat) charge(ctx, await noteMessage(ctx, chat, message))
}

async function findReaction(ctx: MutationCtx, messageId: Id<'messages'>, sender: Sender, key: string) {
  return await ctx.db
    .query('reactions')
    .withIndex('by_message', (q) => q.eq('messageId', messageId).eq('senderKey', senderKey(sender)).eq('key', key))
    .unique()
}

async function applyReaction(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'reaction' }>, network: Network) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  // Every reaction event is applied once, so a replay of an old add (even after the reaction
  // was removed and added again) changes nothing.
  const seen = await ctx.db
    .query('reactionEvents')
    .withIndex('by_event', (q) => q.eq('userId', event.userId).eq('network', network).eq('eventId', event.eventId))
    .unique()
  if (seen) return
  await ctx.db.insert('reactionEvents', { userId: event.userId, network, eventId: event.eventId })
  if (message.redactedAt !== undefined) return
  const existing = await findReaction(ctx, message._id, event.sender, event.key)
  if (!existing) {
    await ctx.db.insert('reactions', {
      userId: event.userId,
      chatId: message.chatId,
      messageId: message._id,
      senderKey: senderKey(event.sender),
      key: event.key,
      eventId: event.eventId,
      addedAt: event.at,
      networkTs: event.networkTs,
    })
    return
  }
  if (existing.removedAt === undefined) return
  await ctx.db.patch(existing._id, {
    eventId: event.eventId,
    addedAt: event.at,
    networkTs: event.networkTs,
    removedAt: undefined,
  })
}

async function applyReactionRemove(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'reactionRemove' }>,
  network: Network,
) {
  const message = await findMessage(ctx, event.userId, network, event.targetEventId)
  if (!message) return
  const existing = await findReaction(ctx, message._id, event.sender, event.key)
  // A removal no newer than the add it would undo (a replay) leaves the reaction alone.
  if (!existing || existing.removedAt !== undefined || existing.addedAt >= event.at) return
  await ctx.db.patch(existing._id, { removedAt: event.at })
}

/** A deleted message keeps its row and place, but loses its content, edits and reactions. */
async function applyRedaction(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'redaction' }>,
  network: Network,
) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  if (message.redactedAt !== undefined) return
  const redaction = { redactedAt: event.networkTs, sealed: undefined, sealedEdit: undefined, editEventId: undefined }
  await ctx.db.patch(message._id, redaction)
  await noteChanged(ctx, { ...message, ...redaction })
  // A message can have any number of reactions, so they're deleted in bounded batches after
  // this transaction, rather than all inside it. Until they're gone, the marker hides them.
  await ctx.db.insert('reactionCleanups', { messageId: message._id, chatId: message.chatId })
  await ctx.scheduler.runAfter(0, internal.cleanup.reactionsOfMessage, { messageId: message._id })
}

async function applyReceipt(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'receipt' }>, network: Network) {
  const chat = await findChat(ctx, event.userId, network, event.portalId)
  if (!chat) throw new Unmappable('missing_chat')
  const key = senderKey(event.sender)
  const existing = await ctx.db
    .query('receipts')
    .withIndex('by_chat_sender', (q) => q.eq('chatId', chat._id).eq('senderKey', key))
    .unique()
  if (existing && existing.networkTs >= event.networkTs) return
  if (existing) await ctx.db.patch(existing._id, { upToEventId: event.upToEventId, networkTs: event.networkTs })
  else {
    await ctx.db.insert('receipts', {
      userId: event.userId,
      chatId: chat._id,
      senderKey: key,
      upToEventId: event.upToEventId,
      networkTs: event.networkTs,
    })
  }
  const read = await findMessage(ctx, event.userId, network, event.upToEventId)
  // A receipt for a message this chat doesn't have says nothing about what's been read here.
  if (!read || read.chatId !== chat._id) return
  // The person reading a chat elsewhere (on their phone) clears it here too, up to the
  // message the receipt covers: a delayed receipt doesn't clear messages that came after it,
  // and one older than what they've already read here changes nothing.
  if (key === 'self') {
    if (readAlready(chat, read.sortKey)) return
    await ctx.db.patch(chat._id, { ...(await unreadAfter(ctx, chat, read)), readSortKey: read.sortKey })
    return
  }
  // Someone else reading the chat has read the person's own messages up to there. Those up to
  // an earlier receipt were marked by it, or as they arrived (applyMessage).
  if (chat.theirReadSortKey !== undefined && read.sortKey <= chat.theirReadSortKey) return
  await ctx.db.patch(chat._id, { theirReadSortKey: read.sortKey })
  await markOwnReadRange(ctx, chat._id, chat.theirReadSortKey ?? null, read.sortKey)
}

/** Whether a message at `sortKey` is at or before the newest one the person has read. */
export function readAlready(chat: Pick<Doc<'chats'>, 'readSortKey'>, sortKey: string) {
  return chat.readSortKey !== undefined && sortKey <= chat.readSortKey
}

/** The most messages one pass of `markOwnReadRange` looks through, before carrying on later. */
const MAX_MARKED_READ = 100

/**
 * Marks the person's own messages after `after` (exclusive; from the start when null) and up to
 * `upTo` read, oldest first. Every one in the range is looked at, even past one already read: a
 * message can arrive late among ones read before it. Delivery only moves forward (`advance`); a
 * copy still pending isn't on the network yet, so no receipt can cover it. It reads at most 100
 * rows within the same budget as a recount, then schedules the rest
 * (`messages.markOwnReadRange`).
 */
export async function markOwnReadRange(ctx: MutationCtx, chatId: Id<'chats'>, after: string | null, upTo: string) {
  let from = after
  let seen = 0
  let bytes = 0
  while (seen < MAX_MARKED_READ) {
    const room = Math.min(Math.floor((MAX_RECOUNT_BYTES - bytes) / MAX_MESSAGE_ROW_BYTES), MAX_MARKED_READ - seen)
    if (room < 1) break
    const batch = await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => {
        const chat = q.eq('chatId', chatId)
        return (from === null ? chat : chat.gt('sortKey', from)).lte('sortKey', upTo)
      })
      .take(room)
    charge(ctx, batch)
    for (const message of batch) {
      bytes += byteSize(message)
      if (!('self' in message.sender) || message.eventId.startsWith('pending:')) continue
      if (message.delivery === 'read') continue
      await ctx.db.patch(message._id, { delivery: advance(message.delivery, 'read') })
    }
    seen += batch.length
    if (batch.length < room) return
    from = batch.at(-1)!.sortKey
  }
  // Rows are left in the range, or may be: the rest is marked in its own transaction.
  if (from !== upTo) {
    await ctx.scheduler.runAfter(0, internal.messages.markOwnReadRange, { chatId, after: from, upTo })
  }
}

/**
 * The most a recount reads. A message row can hold two sealed objects near 256 KiB, so a
 * recount by count alone could pass a transaction's read limit and stall the host's journal.
 */
const MAX_RECOUNT_BYTES = 4 * 1024 * 1024

/**
 * How many messages from other people, and how many of those mention the person, newer than
 * `read` the chat holds. It reads a few rows at a time, only as many as can't pass
 * `MAX_RECOUNT_BYTES` however large they are, and at most 100. If it can't see them all, the
 * chat keeps at least the counts it had: a receipt only ever clears what it was seen to cover.
 */
async function unreadAfter(ctx: MutationCtx, chat: Doc<'chats'>, read: Doc<'messages'>) {
  const prior = { unreadCount: chat.unreadCount, mentionCount: chat.mentionCount ?? 0 }
  const atLeastPrior = (unread: number, mentions: number) => ({
    unreadCount: Math.max(unread, prior.unreadCount),
    mentionCount: Math.max(mentions, prior.mentionCount),
  })
  let after = read.sortKey
  let seen = 0
  let unread = 0
  let mentions = 0
  let bytes = 0
  while (seen < 100) {
    const room = Math.min(Math.floor((MAX_RECOUNT_BYTES - bytes) / MAX_MESSAGE_ROW_BYTES), 100 - seen)
    if (room < 1) return atLeastPrior(unread, mentions)
    const batch = await ctx.db
      .query('messages')
      .withIndex('by_chat_sort', (q) => q.eq('chatId', chat._id).gt('sortKey', after))
      .take(room)
    charge(ctx, batch)
    for (const message of batch) {
      bytes += byteSize(message)
      if ('self' in message.sender || message.historical) continue
      unread++
      if (message.mentionsMe) mentions++
    }
    seen += batch.length
    if (batch.length < room) return { unreadCount: unread, mentionCount: mentions }
    after = batch.at(-1)!.sortKey
  }
  // A hundred newer messages and maybe more: the counts can't be lowered past the prior ones.
  return atLeastPrior(unread, mentions)
}

async function applyTyping(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'typing' }>, network: Network) {
  const chat = await findChat(ctx, event.userId, network, event.portalId)
  if (!chat) return
  const key = senderKey(event.sender)
  const existing = await ctx.db
    .query('typing')
    .withIndex('by_chat_sender', (q) => q.eq('chatId', chat._id).eq('senderKey', key))
    .unique()
  if (!event.typing) {
    if (existing) await ctx.db.delete(existing._id)
    return
  }
  const expiresAt = event.at + Math.min(event.timeoutMs, 30_000)
  if (existing) await ctx.db.patch(existing._id, { expiresAt })
  else await ctx.db.insert('typing', { userId: event.userId, chatId: chat._id, senderKey: key, expiresAt })
}

async function applyChat(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'chat' }>, network: Network) {
  const chat = await chatFor(ctx, event, network)
  await patchChat(ctx, chat, {
    kind: event.kind,
    sealedMeta: event.sealed,
    // A request stays accepted once the person accepts it: only a chat seen for the first
    // time can become one. The network saying it's no longer a request always counts.
    ...(event.isRequest === false ? { isRequest: false } : {}),
    ...(event.isRequest === true && chat.isRequest === undefined ? { isRequest: true } : {}),
    ...(event.parentPortalId ? { parentPortalId: event.parentPortalId } : {}),
    ...(event.deleted ? { deleted: true } : {}),
  })
}

/** The most accounts one contact records (contacts.accountIds). */
const MAX_CONTACT_ACCOUNTS = 10

async function applyContact(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'contact' }>, network: Network) {
  const existing = await ctx.db
    .query('contacts')
    .withIndex('by_ghost', (q) => q.eq('userId', event.userId).eq('network', network).eq('ghostId', event.ghostId))
    .unique()
  charge(ctx, existing)
  const loginId = event.loginId
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', network).eq('loginId', loginId))
    .unique()
  const known = existing?.accountIds ?? []
  // Every account that has sent the contact, newest last, so a chat can start on any of them.
  const accountIds =
    account?.userId === event.userId && !known.includes(account._id)
      ? [...known, account._id].slice(-MAX_CONTACT_ACCOUNTS)
      : known
  if (existing) await ctx.db.patch(existing._id, { sealedProfile: event.sealed, accountIds })
  else
    await ctx.db.insert('contacts', {
      userId: event.userId,
      network,
      ghostId: event.ghostId,
      sealedProfile: event.sealed,
      ...(accountIds.length ? { accountIds } : {}),
    })
}

/**
 * A new chat's outcome settles its request (newChats.start): the chat, created bare if its
 * `chat` event hasn't come yet, or why there is none. Only the request's own login can answer.
 */
async function applyChatStarted(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'chatStarted' }>,
  origin: Origin,
) {
  const { network } = origin
  const request = await ctx.db
    .query('chatStarts')
    .withIndex('by_request', (q) => q.eq('userId', event.userId).eq('requestId', event.requestId))
    .unique()
  charge(ctx, request)
  if (!request || request.network !== network || request.loginId !== event.loginId) {
    throw new Unmappable('unknown_chat_start')
  }
  // Only the host the command was handed to ran it, even if the login has moved since.
  const command = await ctx.db.get(request.commandId)
  if (command?.hostId !== origin.hostId) throw new Unmappable('foreign_host')
  if (request.state !== 'pending') return
  if (event.portalId) {
    const chat = await chatFor(ctx, { userId: event.userId, loginId: event.loginId, portalId: event.portalId }, network)
    await ctx.db.patch(request._id, { state: 'started', chatId: chat._id })
  } else {
    await ctx.db.patch(request._id, { state: 'failed', error: event.error ?? 'internal' })
  }
}

/**
 * What one of the person's logins knows a contact by, sealed to them apart from the profile
 * (kind `contact`, object ID `<ghostId>/identifiers/<loginId>`), so a profile update, which
 * every member with the contact gets, leaves it as it is. Each login's replaces only its own,
 * and it needs no profile first.
 */
async function applyContactIdentifiers(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'contactIdentifiers' }>,
  network: Network,
) {
  const existing = await ctx.db
    .query('contactIdentifiers')
    .withIndex('by_contact', (q) =>
      q.eq('userId', event.userId).eq('network', network).eq('ghostId', event.ghostId).eq('loginId', event.loginId),
    )
    .unique()
  charge(ctx, existing)
  if (existing) await ctx.db.patch(existing._id, { sealed: event.sealed })
  else
    await ctx.db.insert('contactIdentifiers', {
      userId: event.userId,
      network,
      ghostId: event.ghostId,
      loginId: event.loginId,
      sealed: event.sealed,
    })
}

async function applyLoginState(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'loginState' }>,
  origin: Origin,
) {
  const { network } = origin
  const existing = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', network).eq('loginId', event.loginId))
    .unique()
  if (existing && existing.userId !== event.userId) throw new Unmappable('foreign_login')
  // A login's commands go to the host that last reported it connected. A delayed report
  // from a host that ran it before can't take it back.
  const takesOver =
    event.state === 'CONNECTED' &&
    (!existing?.hostId || existing.hostId === origin.hostId || event.at > (existing.hostSince ?? 0))
  if (existing?.hostId && existing.hostId !== origin.hostId && !takesOver) return
  const fields = {
    state: event.state,
    error: event.error,
    updatedAt: event.at,
    ...(takesOver || !existing?.hostId ? { hostId: origin.hostId, hostSince: event.at } : {}),
    ...(event.state === 'CONNECTED' ? { lastHealthyAt: event.at } : {}),
    // Sealed to the owner; the backend only keeps it for their devices to open.
    ...(event.sealed ? { sealedMeta: event.sealed } : {}),
  }
  let accountId = existing?._id
  if (existing) {
    await ctx.db.patch(existing._id, fields)
    if (event.state === 'LOGGED_OUT') await onLoggedOut(ctx, existing)
  } else {
    accountId = await ctx.db.insert('networkAccounts', {
      userId: event.userId,
      network,
      loginId: event.loginId,
      ...fields,
    })
    // A login the person cancelled that finished on the bridge host anyway, whose `complete`
    // step came first: they said no to it, so it's logged out rather than left connected.
    if (event.state !== 'LOGGED_OUT' && (await cancelledLogin(ctx, event.userId, network, event.loginId))) {
      await queueLogout(ctx, (await ctx.db.get(accountId))!)
      return
    }
  }
  // An account on a network an admin removed is logged out, whenever it reports in: one whose
  // login finished as the network was removed, or whose logout didn't take. A network that was
  // never decided on (an older server, before its migrations ran) is left alone.
  if (event.state !== 'LOGGED_OUT' && (await removedNetwork(ctx, network))) {
    await queueLogout(ctx, (await ctx.db.get(accountId!))!)
  }
}

/**
 * Whether one of the person's logins on `loginId` was cancelled and then finished on the
 * bridge host anyway (completedAfterCancel kept its login ID).
 */
async function cancelledLogin(ctx: MutationCtx, userId: string, network: Network, loginId: string) {
  const sessions = await ctx.db
    .query('loginSessions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .take(20)
  return sessions.some(
    (s) => s.state === 'cancelled' && s.network === network && s.loginId === loginId && !retried(sessions, s, loginId),
  )
}

/**
 * Whether, among the person's recent `sessions`, a newer attempt on the same network than
 * `cancelled` connected `loginId` or is still going (it may be about to). The cancel was of
 * that one attempt: logging the account out would undo the retry the person kept.
 */
function retried(sessions: Doc<'loginSessions'>[], cancelled: Doc<'loginSessions'>, loginId: string) {
  return sessions.some(
    (s) =>
      s._id !== cancelled._id &&
      s.network === cancelled.network &&
      s._creationTime > cancelled._creationTime &&
      ((s.state === 'complete' && s.loginId === loginId) || s.state === 'pending' || s.state === 'active'),
  )
}

/**
 * A login the person cancelled (logins.cancel ends it at once) that the bridge host finished
 * before the cancel reached it. It stays cancelled, as the person last saw it, and the new
 * account it made is logged out. An account the person already had, which the login only
 * reconnected, is left as it now is: logging it out would undo more than they asked.
 */
async function completedAfterCancel(ctx: MutationCtx, session: Doc<'loginSessions'>, loginId: string) {
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', session.network).eq('loginId', loginId))
    .unique()
  if (account && account.userId !== session.userId) return
  if (account && account._creationTime < session._creationTime) return
  // Kept so the account's own report, if it comes after this, is logged out too.
  await ctx.db.patch(session._id, { loginId })
  const recent = await ctx.db
    .query('loginSessions')
    .withIndex('by_user', (q) => q.eq('userId', session.userId))
    .order('desc')
    .take(20)
  if (retried(recent, session, loginId)) return
  if (account) await queueLogout(ctx, account)
}

async function applyLoginStep(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'loginStep' }>, origin: Origin) {
  const { hostId } = origin
  const sessionId = ctx.db.normalizeId('loginSessions', event.loginSessionId)
  const session = charge(ctx, sessionId ? await ctx.db.get(sessionId) : null)
  if (!session || session.userId !== event.userId) throw new Unmappable('unknown_login_session')
  // Only the host the login was handed to speaks for it (it is pinned when the start command
  // is handed out, before any host can have a step to report).
  if (session.network !== origin.network || !session.hostId || session.hostId !== origin.hostId) {
    throw new Unmappable('foreign_host')
  }
  // A login that has ended stays ended, whatever step arrives late.
  if (session.state === 'cancelled' && event.step.type === 'complete' && event.step.loginId) {
    await completedAfterCancel(ctx, session, event.step.loginId)
    return
  }
  if (session.state === 'complete' || session.state === 'cancelled' || session.state === 'error') return
  // Login steps are instructions, a code or a QR string, and a few fields: never this big.
  if (byteSize(event.step) > MAX_LOGIN_STEP_BYTES) throw new Unmappable('too_large')
  const state =
    event.step.type === 'complete'
      ? 'complete'
      : event.step.type === 'cancelled'
        ? 'cancelled'
        : event.step.type === 'error'
          ? 'error'
          : 'active'
  await ctx.db.patch(session._id, {
    state,
    step: event.step,
    hostId,
    updatedAt: event.at,
    ...(event.step.loginId ? { loginId: event.step.loginId } : {}),
  })
  if (state !== 'active') await settleCancelledLogins(ctx, session.userId, session.network)
}

/**
 * Decides, for the accounts the person's cancelled logins connected anyway, whether to log them
 * out now. One was left while another attempt on the network was going (retried); this runs
 * whenever one of their logins ends, so it is decided once that attempt settles: logged out
 * unless a newer attempt connected the same account (the one the person kept), or one is
 * still going.
 */
export async function settleCancelledLogins(ctx: MutationCtx, userId: string, network: Network) {
  const sessions = await ctx.db
    .query('loginSessions')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .order('desc')
    .take(20)
  for (const s of sessions) {
    if (s.state !== 'cancelled' || s.network !== network || !s.loginId || retried(sessions, s, s.loginId)) continue
    const loginId = s.loginId
    const account = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', network).eq('loginId', loginId))
      .unique()
    // Only an account that attempt made: one the person had before it is left as it is.
    if (!account || account.userId !== userId || account._creationTime < s._creationTime) continue
    await queueLogout(ctx, account)
  }
}

async function applySendStatus(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'sendStatus' }>,
  origin: Origin,
) {
  const send = await sendFrom(ctx, event.userId, event.clientMessageId, origin)
  if (!send) {
    const elsewhere = await findOutboxSend(ctx, event.userId, event.clientMessageId)
    throw new Unmappable(elsewhere ? 'foreign_host' : 'unknown_send')
  }
  await settleSend(ctx, send, event.status)
  if (event.error) await ctx.db.patch(send._id, { lastError: event.error })
  const message = await findPersonsCopy(ctx, event.userId, event.clientMessageId)
  if (message) await ctx.db.patch(message._id, { delivery: advance(message.delivery, event.status) })
}

/**
 * The most an incoming sealed object may hold. A message row can hold two (the message and
 * its latest edit), which must fit in Convex's 1 MiB document limit as base64 text.
 */
export const MAX_INCOMING_SEALED_BYTES = 256 * 1024
/**
 * Chat and contact metadata (a name, a topic, an avatar's file reference) is small. Capping
 * it keeps a whole inbox of rows well inside one query's read limit.
 */
export const MAX_METADATA_SEALED_BYTES = 8 * 1024
/** The longest ID an event may carry: they are hashes and opaque IDs, never content. */
export const MAX_ID_LENGTH = 256
/** The most a login step may hold, in UTF-8 bytes. */
const MAX_LOGIN_STEP_BYTES = 64 * 1024

const ID_FIELDS = [
  'loginId',
  'portalId',
  'eventId',
  'targetEventId',
  'ghostId',
  'upToEventId',
  'replyTo',
  'threadRoot',
  'clientMessageId',
  'loginSessionId',
  'parentPortalId',
  'key',
  'requestId',
] as const

function hasOversizedId(event: BridgeEventDoc) {
  const fields = event as unknown as Record<string, unknown>
  const ids = [
    ...ID_FIELDS.map((name) => fields[name]),
    event.userId,
    'sender' in event && 'ghostId' in event.sender ? event.sender.ghostId : undefined,
    ...(event.type === 'loginStep'
      ? [
          event.step.stepId,
          event.step.loginId,
          ...(event.step.fields ?? []).map((field) => field.id),
          ...(event.step.cookies?.fields ?? []).map((field) => field.id),
        ]
      : []),
  ]
  return ids.some((id) => typeof id === 'string' && id.length > MAX_ID_LENGTH)
}
/**
 * Whether `origin` may speak for the event's login: once a host is running a login, events
 * for it from any other host are refused. (A login moves hosts only through a newer
 * `CONNECTED` report, which `applyLoginState` decides.)
 */
async function assertLoginOwner(ctx: MutationCtx, event: BridgeEventDoc, origin: Origin) {
  if (event.type === 'loginState' || event.type === 'loginStep' || !event.loginId) return
  // The outcome or echo of a send is checked against the host that send was handed to,
  // which may differ from the login's owner after the login moved hosts.
  if (event.type === 'sendStatus') return
  // So is a new chat's: applyChatStarted checks it against the host its command went to.
  if (event.type === 'chatStarted') return
  if (event.type === 'message' && 'self' in event.sender && event.clientMessageId) {
    const send = await findOutboxSend(ctx, event.userId, event.clientMessageId)
    if (send) return
  }
  const loginId = event.loginId
  const account = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', origin.network).eq('loginId', loginId))
    .unique()
  if (account?.hostId && account.hostId !== origin.hostId) throw new Unmappable('foreign_host')
}

export async function applyEvent(ctx: MutationCtx, event: BridgeEventDoc, origin: Origin) {
  const { network } = origin
  if (hasOversizedId(event)) throw new Unmappable('too_large')
  if ('sealed' in event && event.sealed !== undefined) {
    if (!isEnvelope(event.sealed)) throw new Unmappable('malformed_envelope')
    const limit =
      event.type === 'chat' ||
      event.type === 'contact' ||
      event.type === 'contactIdentifiers' ||
      event.type === 'loginState'
        ? MAX_METADATA_SEALED_BYTES
        : MAX_INCOMING_SEALED_BYTES
    if (!isEnvelope(event.sealed, limit)) throw new Unmappable('too_large')
  }
  await assertLoginOwner(ctx, event, origin)
  switch (event.type) {
    case 'message':
      return await applyMessage(ctx, event, origin)
    case 'edit':
      return await applyEdit(ctx, event, network)
    case 'reaction':
      return await applyReaction(ctx, event, network)
    case 'reactionRemove':
      return await applyReactionRemove(ctx, event, network)
    case 'redaction':
      return await applyRedaction(ctx, event, network)
    case 'receipt':
      return await applyReceipt(ctx, event, network)
    case 'typing':
      return await applyTyping(ctx, event, network)
    case 'chat':
      return await applyChat(ctx, event, network)
    case 'contact':
      return await applyContact(ctx, event, network)
    case 'contactIdentifiers':
      return await applyContactIdentifiers(ctx, event, network)
    case 'chatStarted':
      return await applyChatStarted(ctx, event, origin)
    case 'loginState':
      return await applyLoginState(ctx, event, origin)
    case 'loginStep':
      return await applyLoginStep(ctx, event, origin)
    case 'sendStatus':
      return await applySendStatus(ctx, event, origin)
    case 'backfillDone':
      return
  }
}
