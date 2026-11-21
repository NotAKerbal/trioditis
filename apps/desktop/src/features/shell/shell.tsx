import { toast } from '@trioditis/ui/toast'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useChat, useChatActions, type Chat, type ChatId } from '~/data/chats.ts'
import { NOTHING_READ, readOnOpen } from '~/data/read-on-open.ts'
import { formatWhen } from '~/data/snooze.ts'
import { ChatPane } from '~/features/chat/chat-pane.tsx'
import { NewChatDialog } from '~/features/people/new-chat-dialog.tsx'
import { PeopleDialog, type PeopleView } from '~/features/people/people-dialog.tsx'
import { SettingsDialog, type SettingsSection } from '~/features/settings/settings-dialog.tsx'
import { authClient } from '~/lib/auth-client.ts'
import { BottomBar } from './bottom-bar.tsx'
import { useKeepUnsent } from './keep-unsent.ts'
import { useMessageNotifications } from './notifications.ts'
import { Sidebar, SidebarFrame, type SidebarAction } from './sidebar.tsx'
import { SidebarBoundary } from './sidebar-boundary.tsx'
import { UpdateNotice } from './update-notice.tsx'

/** The signed-in app: one sidebar, the open chat, and its details. */
export function Shell() {
  const search = useSearch({ from: '/' })
  const navigate = useNavigate({ from: '/' })
  const actions = useChatActions()
  const { data: auth } = authClient.useSession()
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
  const openStarted = (chatId: string) => {
    setNewChat(false)
    void navigate({ search: (s) => ({ ...s, people: undefined, chat: chatId }) })
  }

  function open(chat: Chat) {
    if (chat.id !== selectedId) setOpenedUnreadId(chat.hasUnread && !chat.muted ? chat.id : undefined)
    select(chat.id)
    // Opening another chat marks it read once it's shown (useReadWhileOpen). Choosing the open
    // one again doesn't open it again, so a chat marked unread while open is marked read here.
    if (chat.id === selectedId && chat.hasUnread) void actions.markRead(chat.id)
  }

  useMessageNotifications(selectedId, open)
  // Opening a chat, by a click, a notification or a link, marks it read, as does a new message
  // while it's open and on screen (useReadWhileOpen).
  useReadWhileOpen(selectedId as ChatId | undefined, actions.markRead)
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
    if (action.type === 'archive')
      void act(chat.id, async () => {
        const ok = await actions.setArchived(chat.id, true)
        if (ok)
          toast(`Archived ${chat.name}`, { label: 'Undo', onClick: () => void actions.setArchived(chat.id, false) })
        return ok
      })
    if (action.type === 'restore') void act(chat.id, () => actions.setArchived(chat.id, false))
    if (action.type === 'wake') void act(chat.id, () => actions.wake(chat.id))
    if (action.type === 'accept') void act(chat.id, () => actions.acceptRequest(chat.id))
    if (action.type === 'snooze')
      void act(chat.id, async () => {
        const ok = await actions.snooze(chat.id, action.until)
        if (ok)
          toast(`Snoozed ${chat.name} until ${formatWhen(action.until)}`, {
            label: 'Undo',
            onClick: () => void actions.wake(chat.id),
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
        <SidebarBoundary onError={() => (shownRef.current = null)}>
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
        </SidebarBoundary>
      </SidebarFrame>
      <ChatPane
        chatId={selectedId as ChatId | undefined}
        onGone={() => select(undefined)}
        onBack={() => select(undefined)}
        act={act}
      />
      <SettingsDialog
        section={search.settings}
        connect={!!search.connect}
        onSectionChange={(section) => openSettings(section)}
      />
      <PeopleDialog view={search.people} onViewChange={openPeople} onOpenChat={openStarted} />
      <NewChatDialog open={newChat} onOpenChange={setNewChat} onStarted={openStarted} />
      <UpdateNotice />
    </div>
  )
}

/** Whether the window is shown and focused, as it changes: when the person can see the open chat. */
function subscribeSeen(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
}
const seen = () => document.visibilityState === 'visible' && document.hasFocus()

/** Marks the open chat read when it's opened and as messages arrive in it (data/read-on-open.ts). */
function useReadWhileOpen(chatId: ChatId | undefined, markRead: (chatId: ChatId) => Promise<unknown>) {
  // The same object until the chat's row changes, so the effect runs once per change.
  const chat = useChat(chatId)
  const visible = useSyncExternalStore(subscribeSeen, seen)
  const done = useRef(NOTHING_READ)
  useEffect(() => {
    const open = chat && { id: chat.id, unread: chat.unread, markedUnread: chat.row.markedUnread }
    const next = readOnOpen(open, visible, done.current)
    done.current = next.done
    if (next.mark && chat) void markRead(chat.id)
  }, [chat, visible, markRead])
}
