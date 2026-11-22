import type { ChatRow, ChatView } from '@trioditis/core'

/** Which list a chat is in, as the backend keeps it (packages/backend/convex/lib/chatView.ts). */
export function viewOf(row: Pick<ChatRow, 'blocked' | 'isRequest' | 'snoozedUntil' | 'woke' | 'archived'>): ChatView {
  if (row.blocked) return 'blocked'
  if (row.isRequest) return 'requests'
  if (row.snoozedUntil !== null && !row.woke) return 'snoozed'
  if (row.archived) return 'archived'
  return 'inbox'
}

/**
 * Whether a chat belongs in the sidebar under these filters, judged from the chat itself, so a
 * filter change can tell before the chat's page has loaded. `view` is the one view Simple
 * shows; null for Focused, which shows every view.
 */
export function inFilter(
  chat: {
    network: string
    row: Pick<ChatRow, 'labelIds' | 'blocked' | 'isRequest' | 'snoozedUntil' | 'woke' | 'archived'>
  },
  filter: { network: string | undefined; labelId: string | undefined; view: ChatView | null },
): boolean {
  if (filter.network && chat.network !== filter.network) return false
  if (filter.labelId && !chat.row.labelIds.includes(filter.labelId)) return false
  return filter.view === null || viewOf(chat.row) === filter.view
}
