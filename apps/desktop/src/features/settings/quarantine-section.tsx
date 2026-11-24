import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { toast } from '@trioditis/ui/toast'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Disclosure, Group } from './layout.tsx'

// Why the backend couldn't apply an event (lib/ingest.ts, UnmappableReason), in words.
const REASONS: Record<string, string> = {
  missing_target: 'About a message the server doesn’t have',
  missing_chat: 'About a chat the server doesn’t have',
  foreign_login: 'For an account another person connected',
  foreign_host: 'From a bridge host that doesn’t run that account',
  unknown_login_session: 'For a sign-in that has ended',
  unknown_send: 'About a send the server doesn’t know',
  malformed_envelope: 'Not sealed properly',
  too_large: 'Too large',
  unknown_chat_start: 'About a new chat nobody asked for',
  invalid_event: 'Not a valid event',
}

const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * Settings → Admin → Networks: events from bridge hosts the server couldn't apply and skipped,
 * so the rest still came through. Only what kind each was and why: never its content. Shows
 * nothing while there are none.
 */
export function QuarantineSection() {
  const session = useSession()
  const { data } = useQuery(convexQuery(api.quarantine.list, {}))
  const dismiss = useMutation(api.quarantine.dismiss)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!data?.count) return null

  async function run(ids: Id<'quarantine'>[]) {
    setBusy(true)
    try {
      await dismiss({ ids, sessionId: session.sessionId })
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, 'That couldn’t be dismissed.'))
    }
    setBusy(false)
  }

  const count = data.more ? `${data.count}+` : String(data.count)
  return (
    <Group
      title="Skipped events"
      action={
        open ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(data.items.map((row) => row._id))}>
            Dismiss {data.items.length === data.count ? 'all' : `these ${data.items.length}`}
          </Button>
        ) : undefined
      }
    >
      <Disclosure open={open} onOpenChange={setOpen}>
        {count === '1' ? '1 event couldn’t be applied' : `${count} events couldn’t be applied`}
      </Disclosure>
      {open
        ? data.items.map((row) => (
            <div key={row._id} className="flex min-h-[52px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
              <div className="min-w-0 flex-[1_1_10rem]">
                <div className="font-semibold">{REASONS[row.reason] ?? row.reason}</div>
                <div className="text-sm text-muted-foreground">
                  {row.type} · {row.hostId} #{row.seq} · {time.format(row.at)}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run([row._id])}>
                Dismiss
              </Button>
            </div>
          ))
        : null}
    </Group>
  )
}
