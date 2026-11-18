import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type { BridgeEventDoc } from '../validators'
import type { Network } from '@trioditis/core'

// Applying one bridge host event to the tables. See docs/architecture/bridge-protocol.md.
// Every write is keyed so replaying an event changes nothing: the bridge host delivers at
// least once.

/** An event that can't be applied. Quarantined rather than blocking the feed. */
export class Unmappable extends Error {}

type Sender = Extract<BridgeEventDoc, { type: 'message' }>['sender']

export function senderKey(sender: Sender): string {
  return 'self' in sender ? 'self' : `ghost:${sender.ghostId}`
}

/** Network time, zero-padded so strings sort like numbers, then the event ID to break ties. */
export function sortKey(networkTs: number, eventId: string): string {
  return `${Math.max(0, Math.floor(networkTs)).toString().padStart(16, '0')}:${eventId}`
}

async function findChat(ctx: MutationCtx, userId: string, network: Network, portalId: string) {
  return await ctx.db
    .query('chats')
    .withIndex('by_portal', (q) => q.eq('userId', userId).eq('network', network).eq('portalId', portalId))
    .unique()
}

/**
 * The chat for a portal, created bare if the bridge host hasn't described it yet. Its
 * `chat` event fills it in when it comes.
 */
async function chatFor(
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
    unreadCount: 0,
    pinned: false,
    archived: false,
  })
  return (await ctx.db.get(chatId))!
}

async function findMessage(ctx: MutationCtx, userId: string, network: Network, eventId: string) {
  return await ctx.db
    .query('messages')
    .withIndex('by_event', (q) => q.eq('userId', userId).eq('network', network).eq('eventId', eventId))
    .unique()
}

async function targetMessage(ctx: MutationCtx, userId: string, network: Network, eventId: string) {
  const message = await findMessage(ctx, userId, network, eventId)
  if (!message) throw new Unmappable(`No message ${eventId}`)
  return message
}

async function findOutboxSend(ctx: MutationCtx, userId: string, clientMessageId: string) {
  return await ctx.db
    .query('outbox')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
}

const DELIVERY_ORDER: Record<NonNullable<Doc<'messages'>['delivery']>, number> = {
  queued: 0,
  claimed: 1,
  submitted: 2,
  sent: 3,
  delivered: 4,
  read: 5,
  failed: 6,
  unknown: 6,
}

/** Delivery only moves forward, so a late `submitted` can't undo `delivered`. */
function advance(current: Doc<'messages'>['delivery'], next: NonNullable<Doc<'messages'>['delivery']>) {
  if (!current) return next
  if (current === 'failed' || current === 'unknown') {
    // A confirmation that the network did take it settles an unknown outcome.
    return next === 'sent' || next === 'delivered' || next === 'read' ? next : current
  }
  return DELIVERY_ORDER[next] > DELIVERY_ORDER[current] ? next : current
}

async function applyMessage(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'message' }>, network: Network) {
  if (await findMessage(ctx, event.userId, network, event.eventId)) return
  const chat = await chatFor(ctx, event, network)
  const fields = {
    eventId: event.eventId,
    networkTs: event.networkTs,
    sortKey: sortKey(event.networkTs, event.eventId),
    sender: event.sender,
    sealed: event.sealed,
    sealedObjectId: event.eventId,
    historical: event.historical,
    ...(event.replyTo ? { replyTo: event.replyTo } : {}),
    ...(event.threadRoot ? { threadRoot: event.threadRoot } : {}),
  }

  // The echo of a send from Trioditis replaces the person's pending copy.
  const pending = event.clientMessageId
    ? await ctx.db
        .query('messages')
        .withIndex('by_clientMessageId', (q) =>
          q.eq('userId', event.userId).eq('clientMessageId', event.clientMessageId),
        )
        .first()
    : null
  if (pending) {
    await ctx.db.patch(pending._id, { ...fields, delivery: advance(pending.delivery, 'sent') })
  } else {
    await ctx.db.insert('messages', {
      userId: event.userId,
      chatId: chat._id,
      network,
      ...fields,
      ...(event.clientMessageId ? { clientMessageId: event.clientMessageId } : {}),
    })
  }

  // Imported history neither notifies, counts as unread, nor reorders the inbox.
  if (event.historical) return
  const fromSomeoneElse = !('self' in event.sender)
  await ctx.db.patch(chat._id, {
    lastMessageAt: Math.max(chat.lastMessageAt, event.networkTs),
    ...(fromSomeoneElse ? { unreadCount: chat.unreadCount + 1 } : {}),
  })
}

async function applyEdit(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'edit' }>, network: Network) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  if (message.editedAt !== undefined && message.editedAt >= event.networkTs) return
  await ctx.db.patch(message._id, { sealedEdit: event.sealed, editEventId: event.eventId, editedAt: event.networkTs })
}

async function applyReaction(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'reaction' }>, network: Network) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  const key = senderKey(event.sender)
  const existing = await ctx.db
    .query('reactions')
    .withIndex('by_message', (q) => q.eq('messageId', message._id).eq('senderKey', key).eq('key', event.key))
    .unique()
  if (existing) return
  await ctx.db.insert('reactions', {
    userId: event.userId,
    messageId: message._id,
    senderKey: key,
    key: event.key,
    networkTs: event.networkTs,
  })
}

async function applyReactionRemove(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'reactionRemove' }>,
  network: Network,
) {
  const message = await findMessage(ctx, event.userId, network, event.targetEventId)
  if (!message) return
  const existing = await ctx.db
    .query('reactions')
    .withIndex('by_message', (q) =>
      q.eq('messageId', message._id).eq('senderKey', senderKey(event.sender)).eq('key', event.key),
    )
    .unique()
  if (existing) await ctx.db.delete(existing._id)
}

/** A deleted message keeps its row and place, but loses its content and edits. */
async function applyRedaction(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'redaction' }>,
  network: Network,
) {
  const message = await targetMessage(ctx, event.userId, network, event.targetEventId)
  if (message.redactedAt !== undefined) return
  await ctx.db.patch(message._id, {
    redactedAt: event.networkTs,
    sealed: undefined,
    sealedEdit: undefined,
    editEventId: undefined,
  })
  for (const reaction of await ctx.db
    .query('reactions')
    .withIndex('by_message', (q) => q.eq('messageId', message._id))
    .collect()) {
    await ctx.db.delete(reaction._id)
  }
}

async function applyReceipt(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'receipt' }>, network: Network) {
  const chat = await findChat(ctx, event.userId, network, event.portalId)
  if (!chat) throw new Unmappable(`No chat ${event.portalId}`)
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
  // The person reading a chat elsewhere (on their phone) clears it here too.
  if (key === 'self') await ctx.db.patch(chat._id, { unreadCount: 0 })
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
  await ctx.db.patch(chat._id, {
    kind: event.kind,
    sealedMeta: event.sealed,
    ...(event.parentPortalId ? { parentPortalId: event.parentPortalId } : {}),
    ...(event.deleted ? { deleted: true } : {}),
  })
}

async function applyContact(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'contact' }>, network: Network) {
  const existing = await ctx.db
    .query('contacts')
    .withIndex('by_ghost', (q) => q.eq('userId', event.userId).eq('network', network).eq('ghostId', event.ghostId))
    .unique()
  if (existing) await ctx.db.patch(existing._id, { sealedProfile: event.sealed })
  else
    await ctx.db.insert('contacts', {
      userId: event.userId,
      network,
      ghostId: event.ghostId,
      sealedProfile: event.sealed,
    })
}

async function applyLoginState(
  ctx: MutationCtx,
  event: Extract<BridgeEventDoc, { type: 'loginState' }>,
  network: Network,
) {
  const existing = await ctx.db
    .query('networkAccounts')
    .withIndex('by_login', (q) => q.eq('network', network).eq('loginId', event.loginId))
    .unique()
  if (existing && existing.userId !== event.userId)
    throw new Unmappable(`Login ${event.loginId} belongs to someone else`)
  const fields = {
    state: event.state,
    error: event.error,
    updatedAt: event.at,
    ...(event.state === 'CONNECTED' ? { lastHealthyAt: event.at } : {}),
  }
  if (existing) await ctx.db.patch(existing._id, fields)
  else await ctx.db.insert('networkAccounts', { userId: event.userId, network, loginId: event.loginId, ...fields })
}

async function applyLoginStep(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'loginStep' }>) {
  const session = await ctx.db.get(event.loginSessionId as Id<'loginSessions'>)
  if (!session || session.userId !== event.userId) throw new Unmappable(`No login session ${event.loginSessionId}`)
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
    updatedAt: event.at,
    ...(event.step.loginId ? { loginId: event.step.loginId } : {}),
  })
}

async function applySendStatus(ctx: MutationCtx, event: Extract<BridgeEventDoc, { type: 'sendStatus' }>) {
  const send = await findOutboxSend(ctx, event.userId, event.clientMessageId)
  if (!send) throw new Unmappable(`No send ${event.clientMessageId}`)
  await ctx.db.patch(send._id, {
    delivery: advance(send.delivery, event.status),
    ...(event.error ? { lastError: event.error } : {}),
  })
  const message = await ctx.db
    .query('messages')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', event.userId).eq('clientMessageId', event.clientMessageId))
    .first()
  if (message) await ctx.db.patch(message._id, { delivery: advance(message.delivery, event.status) })
}

export async function applyEvent(ctx: MutationCtx, event: BridgeEventDoc, network: Network) {
  switch (event.type) {
    case 'message':
      return await applyMessage(ctx, event, network)
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
    case 'loginState':
      return await applyLoginState(ctx, event, network)
    case 'loginStep':
      return await applyLoginStep(ctx, event)
    case 'sendStatus':
      return await applySendStatus(ctx, event)
    case 'backfillDone':
      return
  }
}
