import type { LastMessage, MessagePlaintext } from '@trioditis/core'
import type { KeyPair } from '@trioditis/crypto'
import { openCached } from '~/lib/sealed.ts'
import type { LastShown } from '~/features/shell/row-preview.ts'

// Opened last messages (openCached), so the list doesn't decrypt every row on each render.
const cache = new Map<string, MessagePlaintext | null>()

/** What a message says in one line, for a preview: its text, or what kind of thing it is. */
export function summarize(message: MessagePlaintext | null): string | null {
  if (!message) return null
  const body = message.body?.trim()
  if (body) return message.type === 'emote' ? `* ${body}` : body
  switch (message.type) {
    case 'image':
      return 'Photo'
    case 'video':
      return 'Video'
    case 'audio':
      return 'Audio'
    case 'file':
      return 'File'
    case 'sticker':
      return 'Sticker'
    case 'location':
      return 'Location'
    default:
      return null
  }
}

/**
 * A chat's last message (chats.list's `lastMessage`), opened on this device as a message is,
 * for the chat list. Null when the row has none yet: a chat whose message predates it until
 * the server fills it in, so "no preview yet", not "no messages".
 */
export function openLastMessage(
  last: LastMessage | null | undefined,
  identity: { keyPair: KeyPair; kid: string; userId: string },
): LastShown | null {
  if (!last) return null
  const opened = last.redacted
    ? null
    : openCached(cache, last.sealed, identity.keyPair, identity.kid, 'message', identity.userId, last.objectId)
  return { at: last.at, self: last.self, redacted: last.redacted, text: summarize(opened) }
}
