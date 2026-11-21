import { api } from '@trioditis/backend/api'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { Component, type ReactNode } from 'react'
import { useChatContent, useWarmChats } from '~/data/chat-content.ts'
import type { Chat } from '~/data/chats.ts'
import { useNetworkContacts, usePeople, usePeopleWarm } from '~/data/people.ts'

/**
 * Fetches ahead the chats the person is about to open (data/chat-content.ts), asking exactly
 * what their pane will ask, and showing nothing. Clicking one then opens it from the cache.
 */
export function WarmChats() {
  const chats = useWarmChats()
  return chats.map((chat) => (
    <Quiet key={chat.id}>
      <WarmChat chat={chat} />
    </Quiet>
  ))
}

/** Fetches the People window's lists ahead while the person reaches for it (data/people.ts). */
export function WarmPeople() {
  const warm = usePeopleWarm()
  return warm ? (
    <Quiet>
      <WarmAddressBook />
    </Quiet>
  ) : null
}

function WarmAddressBook() {
  usePeople()
  useNetworkContacts()
  return null
}

function WarmChat({ chat }: { chat: Chat }) {
  useQuery({ ...convexQuery(api.chats.get, { chatId: chat.id }), retry: false })
  useChatContent(chat)
  return null
}

/**
 * A chat that couldn't be fetched ahead just isn't: opening it asks again, and its pane says
 * what went wrong if it still can't load.
 */
class Quiet extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}
