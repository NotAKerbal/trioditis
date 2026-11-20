import { toast } from '@trioditis/ui/toast'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useChatActions, type Chat, type ChatId } from '~/data/chats.ts'
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
    if (chat.hasUnread) void actions.markRead(chat.id)
  }

  useMessageNotifications(selectedId, open)
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
    <div className="flex h-full bg-background">
      <SidebarFrame
        bottomBar={
          <BottomBar name={auth?.user.name ?? ''} email={auth?.user.email ?? ''} openSettings={openSettings} />
        }
      >
        <SidebarBoundary onError={() => (shownRef.current = null)}>
          <Sidebar
            selectedId={selectedId}
            openedUnreadId={openedUnreadId}
            onOpen={open}
            onClose={() => select(undefined)}
            onAction={onSidebarAction}
            onPeople={() => openPeople('all')}
            onNewChat={() => setNewChat(true)}
            shownRef={shownRef}
            chatsRef={chatsById}
          />
        </SidebarBoundary>
      </SidebarFrame>
      <ChatPane chatId={selectedId as ChatId | undefined} onGone={() => select(undefined)} act={act} />
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
