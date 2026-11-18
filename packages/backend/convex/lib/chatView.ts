import type { ChatView } from '@trioditis/core'
import type { Doc, Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'

// Which list a chat is in. Every chat is in exactly one, stored on the chat (`view`) so each
// list is an index range. Anything that changes a chat's flags goes through `patchChat`, here
// and in ingest, so `view` can't fall out of step.
//
// Precedence, strongest first:
//   blocked   always, whatever else is set
//   requests  a request stays a request while archived or snoozed
//   snoozed   snoozed and not yet woken, even if archived
//   archived
//   inbox     everything else, including a woken snooze
// Waking a snooze (by time or a new message) also unarchives the chat: it comes back.

type ViewFields = Partial<
  Pick<Doc<'chats'>, 'blocked' | 'isRequest' | 'snoozedUntil' | 'woke' | 'archived' | 'deleted'>
>

export function chatViewOf(chat: ViewFields): ChatView | undefined {
  if (chat.deleted) return undefined
  if (chat.blocked) return 'blocked'
  if (chat.isRequest) return 'requests'
  if (chat.snoozedUntil !== undefined && !chat.woke) return 'snoozed'
  if (chat.archived) return 'archived'
  return 'inbox'
}

type ChatChanges = Partial<Omit<Doc<'chats'>, '_id' | '_creationTime' | 'userId' | 'view'>>

/**
 * Applies `changes` to a chat and keeps its `view` in step. A change that wakes a snooze
 * also unarchives the chat.
 */
export async function patchChat(ctx: MutationCtx, chat: Doc<'chats'>, changes: ChatChanges) {
  const waking = changes.woke === true && chat.woke !== true
  const next = { ...chat, ...changes, ...(waking ? { archived: false } : {}) }
  await ctx.db.patch(chat._id, { ...changes, ...(waking ? { archived: false } : {}), view: chatViewOf(next) })
}

/** Sets `view` on a chat written without it (a new chat), from its current fields. */
export async function refreshChatView(ctx: MutationCtx, chatId: Id<'chats'>) {
  const chat = await ctx.db.get(chatId)
  if (chat && chat.view !== chatViewOf(chat)) await ctx.db.patch(chatId, { view: chatViewOf(chat) })
}
