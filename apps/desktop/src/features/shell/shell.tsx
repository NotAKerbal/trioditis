import { toast } from '@trioditis/ui/toast'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { membersOf, onEach, useChatActions, type Chat, type ChatId } from '~/data/chats.ts'
import { requestSendOn, setConversations, setDmChats, useConversationIds } from '~/data/conversations.ts'
import { formatWhen } from '~/data/snooze.ts'
import { ChatPane } from '~/features/chat/chat-pane.tsx'
import { isShownNow } from '~/features/chat/read-while-open.tsx'
import { WarmChats, WarmPeople } from '~/features/chat/warm-chats.tsx'
import { NewChatDialog } from '~/features/people/new-chat-dialog.tsx'
import { PeopleDialog, type PeopleView } from '~/features/people/people-dialog.tsx'
import { SettingsDialog, type SettingsSection } from '~/features/settings/settings-dialog.tsx'
import { authClient } from '~/lib/auth-client.ts'
import { useSession } from '~/lib/session.tsx'
import { BottomBar } from './bottom-bar.tsx'
import { useKeepUnsent } from './keep-unsent.ts'
import { useMessageNotifications } from './notifications.ts'
import { Sidebar, SidebarFrame, type SidebarAction } from './sidebar.tsx'
import { LoadError, RetryBoundary } from './retry-boundary.tsx'
import { UpdateNotice } from './update-notice.tsx'

/** The signed-in app: one sidebar, the open chat, and its details. */
export function Shell() {
  const search = useSearch({ from: '/' })
  const navigate = useNavigate({ from: '/' })
  const actions = useChatActions()
  const { data: auth } = authClient.useSession()
  const session = useSession()
  const [openedUnreadId, setOpenedUnreadId] = useState<string | undefined>()
  const shownRef = useRef<string[] | null>(null)
  // The chats the sidebar has loaded, by ID, so auto-advance can open the next one properly.
  const chatsById = useRef(new Map<string, Chat>())
  const selectedId = search.chat
  // The open chat as of now, for an action that finishes later: `selectedId` is as of its start.
  const selectedRef = useRef(selectedId)
  selectedRef.current = selectedId

  const select = (id: string | undefined) => void navigate({ search: (s) => ({ ...s, chat: id }) })
  // `connect` opens Accounts with its networks showing; any other way there drops it.
  const openSettings = (section: SettingsSection | undefined, connect?: boolean) =>
    void navigate({ search: (s) => ({ ...s, settings: section, connect: connect ? (true as const) : undefined }) })
  const openPeople = (people: PeopleView | undefined) => void navigate({ search: (s) => ({ ...s, people }) })
  const [newChat, setNewChat] = useState(false)
  // A chat just started opens at once, though its row may not be in the list yet.
  // From a profile's Message or Open too: its pane then sends on that chat (conversations.ts).
  const openStarted = (chatId: string) => {
    requestSendOn(chatId)
    setNewChat(false)
    void navigate({ search: (s) => ({ ...s, people: undefined, chat: chatId }) })
  }

  // The open chat and the rest of its conversation: a person's direct chats on other networks.
  const openIds = useConversationIds(selectedId)

  function open(chat: Chat) {
    const members = membersOf(chat)
    const isOpen = members.some((m) => m.id === selectedId)
    if (!isOpen) {
      setOpenedUnreadId(chat.hasUnread && !chat.muted ? chat.id : undefined)
      select(chat.id)
    }
    // Opening another chat marks it read once it's shown (read-while-open.tsx). Choosing the open
    // one again doesn't open it again, so a chat marked unread while open is marked read here:
    // each of its chats whose messages are on screen, not one still loading or held back.
    if (isOpen) for (const m of members) if (m.hasUnread && isShownNow(m.id)) void actions.markRead(m.id)
  }

  useMessageNotifications(openIds, open)
  useKeepUnsent()

  /**
   * Runs an action on a chat. If that chat was open and on screen, and the action takes it off
   * the list (archive, snooze, block…), the next chat after it opens, or the one before, or none.
   * Other actions (pin, labels, mute) leave the open chat alone.
   */
  async function act(chatId: ChatId, run: () => Promise<boolean>) {
    // Null while the list is loading or couldn't load: then there's no knowing what it showed.
    const before = shownRef.current ? [...shownRef.current] : null
    const wasOpenAndShown = before !== null && chatId === selectedId && before.includes(chatId)
    const ok = await run()
    if (!ok || !wasOpenAndShown) return
    // A Convex mutation resolves once its query results have arrived; give React a frame to
    // render them before checking whether the chat is still listed.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    // If the person opened another chat (or closed it) meanwhile, that choice stands.
    if (selectedRef.current !== chatId) return
    const shown = shownRef.current
    if (!shown || shown.includes(chatId)) return
    const i = before.indexOf(chatId)
    const listed = (id: string) => shown.includes(id)
    const nextId = before.slice(i + 1).find(listed) ?? before.slice(0, i).reverse().find(listed)
    const next = nextId ? chatsById.current.get(nextId) : undefined
    // Moving on to the next chat opens it, the same as clicking it: it counts as read.
    if (next) open(next)
    else select(undefined)
  }

  function onSidebarAction(action: SidebarAction) {
    const { chat } = action
    // A conversation's row acts on each of its chats; the open one, if it's among them, is what
    // auto-advance watches.
    const members = membersOf(chat)
    const id = members.find((m) => m.id === selectedId)?.id ?? chat.id
    const each = (run: (chatId: ChatId) => Promise<boolean>) => onEach(members, run)
    if (action.type === 'archive')
      void act(id, async () => {
        const ok = await each((c) => actions.setArchived(c, true))
        if (ok)
          toast(`Archived ${chat.name}`, {
            label: 'Undo',
            onClick: () => void each((c) => actions.setArchived(c, false)),
          })
        return ok
      })
    if (action.type === 'restore') void act(id, () => each((c) => actions.setArchived(c, false)))
    if (action.type === 'wake') void act(id, () => each((c) => actions.wake(c)))
    if (action.type === 'accept') void act(id, () => each((c) => actions.acceptRequest(c)))
    if (action.type === 'snooze')
      void act(id, async () => {
        const ok = await each((c) => actions.snooze(c, action.until))
        if (ok)
          toast(`Snoozed ${chat.name} until ${formatWhen(action.until)}`, {
            label: 'Undo',
            onClick: () => void each((c) => actions.wake(c)),
          })
        return ok
      })
  }

  return (
    // Side by side on a wide screen; on a narrow one (under 768px) one pane at a time: the list,
    // or the open chat with a way back, and its details over it (chat-pane.tsx).
    <div className="flex h-full bg-background">
      <SidebarFrame
        chatOpen={!!selectedId}
        bottomBar={
          <BottomBar name={auth?.user.name ?? ''} email={auth?.user.email ?? ''} openSettings={openSettings} />
        }
      >
        <RetryBoundary
          offline={session.offline}
          onError={() => {
            shownRef.current = null
            // What the failed list said goes with it: the open chat stands alone until it's back.
            setConversations([])
            setDmChats([])
          }}
          fallback={(say, retry) => <LoadError say={say('Couldn’t load your chats.')} onRetry={retry} />}
        >
          {() => (
            <Sidebar
              selectedId={selectedId}
              openedUnreadId={openedUnreadId}
              onOpen={open}
              onOpenId={select}
              onClose={() => select(undefined)}
              onAction={onSidebarAction}
              onPeople={() => openPeople('all')}
              onNewChat={() => setNewChat(true)}
              shownRef={shownRef}
              chatsRef={chatsById}
            />
          )}
        </RetryBoundary>
      </SidebarFrame>
      <ChatPane
        chatId={selectedId as ChatId | undefined}
        chatIds={openIds as ChatId[]}
        onGone={() => select(undefined)}
        onBack={() => select(undefined)}
        act={act}
        onOpenPerson={(personKey) => openPeople(`p:${personKey}`)}
        onOpenChat={openStarted}
      />
      <SettingsDialog
        section={search.settings}
        connect={!!search.connect}
        onSectionChange={(section) => openSettings(section)}
      />
      <PeopleDialog view={search.people} onViewChange={openPeople} onOpenChat={openStarted} />
      <NewChatDialog open={newChat} onOpenChange={setNewChat} onStarted={openStarted} />
      <UpdateNotice />
      <WarmChats />
      <WarmPeople />
    </div>
  )
}
