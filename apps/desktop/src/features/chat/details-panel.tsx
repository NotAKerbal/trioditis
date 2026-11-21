import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { useMutation } from 'convex/react'
import { Ban, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Id } from '@trioditis/backend/dataModel'
import {
  networkName,
  onEach,
  useChatActions,
  useLabels,
  type Chat,
  type ChatId,
  type Label,
  type LabelId,
} from '~/data/chats.ts'
import { LabelDot } from '~/features/shell/label-dot.tsx'
import { PersonProfile, type ContactRef } from '~/features/people/profile.tsx'
import { ChatAvatar } from './attachments.tsx'
import { labelName, MAX_LABEL_NAME, renamedLabel } from './labels.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { LABEL_COLORS, newClientId, sealLabel, type LabelColor } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

/** What the side panel shows: the open chat's details, or the profile of someone in it. */
export type PanelView = { kind: 'chat' } | { kind: 'person'; contact: ContactRef; name: string }

export function DetailsPanel({
  chat,
  members,
  view,
  act,
  onClose,
  returnFocus,
  onOpenChat,
  onOpenPerson,
}: {
  /** The open chat, or the conversation it's in (conversations.ts). */
  chat: Chat
  /** The chats it stands for, which its labels and blocking change together. */
  members: readonly Chat[]
  view: PanelView
  act: (chatId: ChatId, run: () => Promise<boolean>) => Promise<void>
  onClose: () => void
  /** What opened it, where focus goes back when the sheet closes. */
  returnFocus: RefObject<HTMLElement | null>
  onOpenChat: (chatId: Id<'chats'>) => void
  onOpenPerson: (personKey: string) => void
}) {
  const actions = useChatActions()
  const labels = useLabels()
  const [managing, setManaging] = useState(false)
  const wide = useWide()
  // The sheet goes by unmounting, when Radix may not get to put focus back: do it here.
  useEffect(() => {
    if (wide) return
    const back = returnFocus.current
    return () => {
      requestAnimationFrame(() => {
        if (!document.activeElement || document.activeElement === document.body) back?.focus()
      })
    }
  }, [wide, returnFocus])
  // A label is on a conversation when it's on any of its chats; choosing it puts it on all.
  const on = new Set(chat.row.labelIds)
  const toggleLabel = (id: LabelId) => {
    const adding = !on.has(id)
    void act(chat.id, () =>
      onEach(members, (chatId) => {
        const now = members.find((m) => m.id === chatId)!.row.labelIds as LabelId[]
        return actions.setLabels(chatId, adding ? [...new Set([...now, id])] : now.filter((l) => l !== id))
      }),
    )
  }
  const here = new Set<string>(members.map((m) => m.id))
  // Who a direct chat is with: any of the conversation's chats can say.
  const dm = chat.row.kind === 'dm' ? (members.find((m) => m.dmGhostId) ?? chat) : undefined
  const dmContact = dm?.dmGhostId ? { network: dm.network, ghostId: dm.dmGhostId } : undefined
  const label = view.kind === 'person' ? 'Profile' : 'Chat details'

  const body =
    view.kind === 'person' ? (
      <PersonProfile
        key={`${view.contact.network}/${view.contact.ghostId}`}
        contact={view.contact}
        fallbackName={view.name}
        here={here}
        onOpenChat={onOpenChat}
        onOpenPerson={onOpenPerson}
      />
    ) : (
      <>
        {dm ? (
          <PersonProfile
            contact={dmContact}
            fallbackName={chat.name}
            fallbackAvatar={<ChatAvatar chat={chat} size={68} className="mx-auto" />}
            here={here}
            onOpenChat={onOpenChat}
            onOpenPerson={onOpenPerson}
          />
        ) : (
          <div className="px-5 pt-6 pb-2 text-center">
            <ChatAvatar chat={chat} size={68} className="mx-auto" />
            <h2 className="mt-2.5 text-lg font-bold">{chat.name}</h2>
            <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-subtle-foreground">
              <NetworkBadge network={chat.network} label={networkName(chat.network)} size={14} />{' '}
              {`Group on ${networkName(chat.network)}`}
            </p>
            {chat.topic ? <p className="mt-2 text-sm text-muted-foreground">{chat.topic}</p> : null}
          </div>
        )}

        <section className="px-5 py-4" aria-labelledby="details-labels">
          <div className="mb-2.5 flex items-center">
            <h3 id="details-labels" className="flex-1 text-sm font-semibold text-muted-foreground">
              Labels
            </h3>
            {labels?.length ? (
              <Button variant="link" size="sm" className="h-auto" onClick={() => setManaging(!managing)}>
                {managing ? 'Done' : 'Edit'}
              </Button>
            ) : null}
          </div>
          {managing && labels?.length ? (
            <ul className="space-y-1.5">
              {labels.map((l) => (
                <li key={l.id}>
                  <EditLabel label={l} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {labels?.map((l) => (
                <Button
                  variant="bare"
                  key={l.id}
                  type="button"
                  aria-pressed={on.has(l.id)}
                  onClick={() => toggleLabel(l.id)}
                  className={cn(
                    'inline-flex h-[26px] items-center gap-1.5 rounded-full border border-dashed border-border-strong px-2.5 text-sm font-medium text-subtle-foreground',
                    on.has(l.id) && 'border-solid text-foreground',
                  )}
                >
                  <LabelDot color={l.color} /> {l.name}
                </Button>
              ))}
              <NewLabel
                onCreated={(id) =>
                  void act(chat.id, () =>
                    onEach(members, (chatId) => {
                      const now = members.find((m) => m.id === chatId)!.row.labelIds as LabelId[]
                      return actions.setLabels(chatId, [...now, id])
                    }),
                  )
                }
              />
            </div>
          )}
        </section>

        <section className="px-5 py-4">
          <Button
            variant="danger"
            size="sm"
            block
            onClick={() =>
              void act(chat.id, () => onEach(members, (chatId) => actions.setBlocked(chatId, !chat.row.blocked)))
            }
          >
            <Ban className="size-3.5" /> {chat.row.blocked ? 'Unblock' : 'Block'}
          </Button>
          {chat.row.blocked ? null : (
            <p className="mt-2 text-sm text-subtle-foreground">Hides it here only. Its messages still arrive.</p>
          )}
        </section>
      </>
    )

  if (wide)
    return (
      <aside className="w-[292px] shrink-0 overflow-y-auto border-l border-border bg-surface" aria-label={label}>
        {body}
      </aside>
    )
  // Under 1024px there's no room beside the chat: the details come over it as a sheet from the
  // right, the whole width on a phone. A dialog, so the chat behind is inert and out of the tab
  // order, focus stays in the sheet, and closing puts it back on the button that opened it.
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        closeLabel={`Close ${label.toLowerCase()}`}
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          returnFocus.current?.focus()
        }}
        className="top-0 right-0 left-auto h-full max-h-none w-[min(100%,360px)] translate-x-0 translate-y-0 overflow-y-auto rounded-none pt-12 max-sm:w-full"
      >
        <DialogTitle className="sr-only">{label}</DialogTitle>
        {body}
      </DialogContent>
    </Dialog>
  )
}

const WIDE = '(min-width: 1024px)'
/** Whether the window is wide enough for the details beside the chat. */
function useWide() {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(WIDE)
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    },
    () => window.matchMedia(WIDE).matches,
  )
}

/** Makes a label. Its name and colour are sealed to the person; the server sees neither. */
function NewLabel({ onCreated }: { onCreated: (id: LabelId) => void }) {
  const session = useSession()
  const create = useMutation(api.labels.create)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>('blue')

  if (!editing) {
    return (
      <Button
        variant="bare"
        type="button"
        aria-label="New label"
        onClick={() => setEditing(true)}
        className="inline-flex h-[26px] items-center rounded-full border border-dashed border-border-strong px-2 text-subtle-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" />
      </Button>
    )
  }
  return (
    <form
      className="mt-1 w-full space-y-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        const labelKey = newClientId()
        try {
          const id = await create({
            labelKey,
            sealed: sealLabel({ name: trimmed, color }, labelKey, session.userId, session.keyPair.publicKey),
            // Sealed to this page's account: refused if the browser has moved to another since.
            sessionId: session.sessionId,
          })
          onCreated(id)
          setEditing(false)
          setName('')
        } catch (err) {
          if (sessionChanged(err)) return window.location.reload()
          toast(errorMessage(err, 'That label couldn’t be made.'))
        }
      }}
    >
      <Input
        autoFocus
        placeholder="Label name"
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Label name"
      />
      <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Label colour">
        {LABEL_COLORS.map((c) => (
          <Button
            variant="bare"
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            onClick={() => setColor(c)}
            className={cn('flex size-6 items-center justify-center rounded-full', color === c && 'ring-2 ring-ring')}
          >
            <LabelDot color={c} className="size-3" />
          </Button>
        ))}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!name.trim()}>
          Add
        </Button>
      </div>
    </form>
  )
}

/**
 * Renames, recolours or deletes one of the person's labels, for every chat that has it. The
 * new name and colour are sealed under the label's own key, as when it was made.
 */
function EditLabel({ label }: { label: Label }) {
  const session = useSession()
  const update = useMutation(api.labels.update)
  const remove = useMutation(api.labels.remove)
  const [name, setName] = useState(label.name)
  const [color, setColor] = useState<LabelColor>(label.color)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const changed = labelName(name) !== label.name || color !== label.color

  async function run(work: () => Promise<unknown>, failed: string) {
    setBusy(true)
    try {
      await work()
    } catch (err) {
      toast(errorMessage(err, failed))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-1.5 rounded-lg p-1.5 shadow-[0_0_0_1px_var(--border)]"
      onSubmit={(e) => {
        e.preventDefault()
        const renamed = renamedLabel(label, name, color, session)
        if (renamed && changed) void run(() => update(renamed), 'That label couldn’t be saved.')
      }}
    >
      <Input
        value={name}
        maxLength={MAX_LABEL_NAME}
        onChange={(e) => setName(e.target.value)}
        aria-label={`Name of label ${label.name}`}
      />
      <div className="flex items-center gap-1" role="radiogroup" aria-label={`Colour of label ${label.name}`}>
        {LABEL_COLORS.map((c) => (
          <Button
            variant="bare"
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={c}
            onClick={() => setColor(c)}
            className={cn('flex size-6 items-center justify-center rounded-full', color === c && 'ring-2 ring-ring')}
          >
            <LabelDot color={c} className="size-3" />
          </Button>
        ))}
        <span className="flex-1" />
        {confirming ? (
          <>
            <Button size="sm" variant="ghost" type="button" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button
              size="sm"
              variant="danger"
              type="button"
              disabled={busy}
              onClick={() => void run(() => remove({ labelId: label.id }), 'That label couldn’t be deleted.')}
            >
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              type="button"
              aria-label={`Delete label ${label.name}`}
              title="Delete label"
              onClick={() => setConfirming(true)}
            >
              <Trash2 className="size-3.5" />
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy || !changed || !labelName(name)}>
              Save
            </Button>
          </>
        )}
      </div>
      {confirming ? <p className="px-1 text-sm text-muted-foreground">It comes off every chat that has it.</p> : null}
    </form>
  )
}
