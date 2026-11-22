import { Component, type ReactNode } from 'react'
import { useWarmChat, useWarmChats } from '~/data/chat-content.ts'
import type { Chat } from '~/data/chats.ts'
import { fetchAheadFailed } from '~/data/fetched-ahead.ts'
import { useNetworkContacts, usePeople, usePeopleWarm } from '~/data/people.ts'

/**
 * Fetches ahead the chats the person is about to open (data/chat-content.ts), asking exactly
 * what their pane will ask, and showing nothing. Clicking one then opens it from the cache.
 */
export function WarmChats() {
  const chats = useWarmChats()
  return chats.map((chat) => (
    <Quiet key={chat.id} onFailed={() => fetchAheadFailed(`chat:${chat.id}`)}>
      <WarmChat chat={chat} />
    </Quiet>
  ))
}

/** Fetches the People window's lists ahead while the person reaches for it (data/people.ts). */
export function WarmPeople() {
  const warm = usePeopleWarm()
  return warm ? (
    <Quiet onFailed={() => fetchAheadFailed('people')}>
      <WarmAddressBook />
    </Quiet>
  ) : null
}

function WarmAddressBook() {
  // Into the cache the People window reads from (data/people.ts, PagesFrom).
  usePeople('cached')
  useNetworkContacts('cached')
  return null
}

// Not the chat itself (chats.get): the pane opens with the sidebar's row while it asks, and a
// failed answer kept in the cache would close the chat as it opened.
function WarmChat({ chat }: { chat: Chat }) {
  useWarmChat(chat)
  return null
}

/**
 * A chat that couldn't be fetched ahead just isn't: it's noted (data/fetched-ahead.ts), so opening
 * it asks afresh rather than from the failed cache, and its pane says what went wrong if it
 * still can't load.
 */
class Quiet extends Component<{ children: ReactNode; onFailed: () => void }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch() {
    this.props.onFailed()
  }
  override render() {
    return this.state.failed ? null : this.props.children
  }
}
