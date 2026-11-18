import { api } from '@trioditis/backend/api'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { useMutation } from 'convex/react'
import { Archive, ArchiveRestore, Ban, Bell, BellOff, Eye, Lock, Pin, Plus } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { networkName, useChatActions, useLabels, type Chat, type ChatId, type LabelId } from '~/data/chats.ts'
import { LabelDot } from '~/features/shell/label-dot.tsx'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { LABEL_COLORS, newClientId, sealLabel, type LabelColor } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

export function DetailsPanel({
  chat,
  act,
}: {
  chat: Chat
  act: (chatId: ChatId, run: () => Promise<boolean>) => Promise<void>
}) {
  const actions = useChatActions()
  const labels = useLabels()
  const on = new Set(chat.row.labelIds)
  const toggleLabel = (id: LabelId) => {
    const next = on.has(id) ? chat.row.labelIds.filter((l) => l !== id) : [...chat.row.labelIds, id]
    void act(chat.id, () => actions.setLabels(chat.id, next as LabelId[]))
  }

  return (
    <aside className="w-[292px] shrink-0 overflow-y-auto border-l border-border bg-surface" aria-label="Chat details">
      <div className="border-b border-border px-5 pt-6 pb-4 text-center">
        <Avatar name={chat.name} size={68} shape={chat.row.kind === 'dm' ? 'circle' : 'square'} className="mx-auto" />
        <h2 className="mt-2.5 text-lg font-bold">{chat.name}</h2>
        <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-subtle-foreground">
          <NetworkBadge network={chat.network} label={networkName(chat.network)} size={14} />{' '}
          {chat.row.kind === 'dm' ? networkName(chat.network) : `Group on ${networkName(chat.network)}`}
        </p>
        {chat.topic ? <p className="mt-2 text-sm text-muted-foreground">{chat.topic}</p> : null}
        <div className="mt-3.5 flex justify-center gap-2">
          <Quick
            on={chat.row.pinned}
            icon={<Pin />}
            label={chat.row.pinned ? 'Pinned' : 'Pin'}
            onClick={() => void act(chat.id, () => actions.setPinned(chat.id, !chat.row.pinned))}
          />
          <Quick
            on={chat.muted}
            icon={chat.muted ? <BellOff /> : <Bell />}
            label={chat.muted ? 'Muted' : 'Mute'}
            onClick={() => void act(chat.id, () => actions.setMuted(chat.id, !chat.muted))}
          />
          <Quick icon={<Eye />} label="Unread" onClick={() => void act(chat.id, () => actions.markUnread(chat.id))} />
          <Quick
            on={chat.row.archived}
            icon={chat.row.archived ? <ArchiveRestore /> : <Archive />}
            label={chat.row.archived ? 'Archived' : 'Archive'}
            onClick={() => void act(chat.id, () => actions.setArchived(chat.id, !chat.row.archived))}
          />
        </div>
      </div>

      <section className="border-b border-border px-5 py-4">
        <h3 className="mb-2.5 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">Labels</h3>
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
              void act(chat.id, () => actions.setLabels(chat.id, [...(chat.row.labelIds as LabelId[]), id]))
            }
          />
        </div>
      </section>

      <section className="border-b border-border px-5 py-4">
        <Button
          variant="danger"
          size="sm"
          block
          onClick={() => void act(chat.id, () => actions.setBlocked(chat.id, !chat.row.blocked))}
        >
          <Ban className="size-3.5" /> {chat.row.blocked ? 'Unblock' : 'Block'}
        </Button>
        <p className="mt-2 text-sm text-subtle-foreground">
          Blocking hides this chat here. The network isn’t told yet, so messages still arrive.
        </p>
      </section>

      <p className="flex gap-2 px-5 py-4 text-sm text-subtle-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" /> Sealed. Messages are stored encrypted to your devices; the server
        can’t read them.
      </p>
    </aside>
  )
}

function Quick({ on, icon, label, onClick }: { on?: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <Button
      variant="bare"
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex w-[62px] flex-col items-center gap-1 rounded-[10px] bg-surface-2 pt-2 pb-1.5 text-xs font-medium text-muted-foreground hover:bg-rail-hover hover:text-foreground [&_svg]:size-[17px]',
        on && 'bg-primary-soft text-primary-ink',
      )}
    >
      {icon}
      {label}
    </Button>
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
