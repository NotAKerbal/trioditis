import { api } from '@trioditis/backend/api'
import type { Doc, Id } from '@trioditis/backend/dataModel'
import type { Network } from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { networkName } from '~/lib/networks.ts'
import { tryOpen, type ChatMeta } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

/** A chat as the app shows it: its sealed metadata opened on this device. */
export interface InboxChat {
  id: Id<'chats'>
  network: Network
  kind: Doc<'chats'>['kind']
  name: string
  topic: string | undefined
  /** False while the bridge host hasn't described the chat yet, or this device can't open it. */
  described: boolean
  unread: number
  pinned: boolean
  archived: boolean
  muted: boolean
  lastMessageAt: number
}

// Opened metadata, by chat and ciphertext, so a list re-render doesn't decrypt everything again.
const metaCache = new Map<string, ChatMeta | null>()

function openMeta(chat: Doc<'chats'>, session: ReturnType<typeof useSession>): ChatMeta | null {
  if (!chat.sealedMeta) return null
  const key = `${chat._id}:${chat.sealedMeta.ct}`
  if (!metaCache.has(key)) metaCache.set(key, tryOpen<ChatMeta>(chat.sealedMeta, session.keyPair, 'chat', session.userId, chat.portalId))
  return metaCache.get(key) ?? null
}

function fallbackName(chat: Doc<'chats'>) {
  const where = networkName(chat.network)
  return chat.kind === 'dm' ? `Chat on ${where}` : `Group on ${where}`
}

export function toInboxChat(chat: Doc<'chats'>, session: ReturnType<typeof useSession>, now = Date.now()): InboxChat {
  const meta = openMeta(chat, session)
  return {
    id: chat._id,
    network: chat.network,
    kind: chat.kind,
    name: meta?.name?.trim() || fallbackName(chat),
    topic: meta?.topic,
    described: !!meta,
    unread: chat.unreadCount,
    pinned: chat.pinned,
    archived: chat.archived,
    muted: (chat.mutedUntil ?? 0) > now,
    lastMessageAt: chat.lastMessageAt,
  }
}

/** Every chat, archived ones included, newest first. `undefined` while loading. */
export function useInbox(): InboxChat[] | undefined {
  const session = useSession()
  const { data } = useQuery(convexQuery(api.chats.list, { includeArchived: true }))
  return useMemo(() => data?.map((chat) => toInboxChat(chat, session)), [data, session])
}

/** The person's connected network accounts. */
export function useAccounts() {
  return useQuery(convexQuery(api.logins.accounts, {})).data
}
