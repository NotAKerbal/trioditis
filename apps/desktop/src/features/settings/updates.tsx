import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { useState, type ReactNode } from 'react'
import {
  CHANNELS,
  channelName,
  runningVersion,
  shortCommit,
  updaterStale,
  updateView,
  when,
  type Channel,
  type UpdateStatus,
} from '~/data/updates.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Heading, Setting } from './layout.tsx'

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** Admin settings → Updates: the release channel, automatic updates, and updating now. */
export function Updates() {
  const { data: status } = useQuery(convexQuery(api.updates.status, {}))
  return (
    <>
      <Heading
        title="Updates"
        lead="Keep this server up to date. An update doesn’t sign anyone out: pages pick up the new version on their own."
      />
      {status ? <UpdateSettings status={status} /> : null}
    </>
  )
}

function UpdateSettings({ status }: { status: UpdateStatus }) {
  const session = useSession()
  const setChannel = useMutation(api.updates.setChannel)
  const setAutoUpdate = useMutation(api.updates.setAutoUpdate)
  const version = runningVersion(status)
  const off = !status.updaterConfigured

  async function run(action: () => Promise<unknown>, failure: string) {
    try {
      await action()
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, failure))
    }
  }

  return (
    <>
      <Setting
        title="This server"
        about={
          version
            ? `Version ${shortCommit(version.commit)}${version.committedAt ? `, from ${date.format(version.committedAt)}` : ''}.`
            : 'Its version isn’t known.'
        }
      >
        {null}
      </Setting>
      <UpdateState status={status} />
      <Setting title="Channel" about={CHANNELS.find((c) => c.id === status.channel)!.about}>
        <Segmented
          value={status.channel}
          onValueChange={(v) =>
            void run(
              () => setChannel({ channel: v as Channel, sessionId: session.sessionId }),
              'The channel couldn’t be changed.',
            )
          }
          className="w-[200px]"
          aria-label="Channel"
        >
          {CHANNELS.map((c) => (
            <SegmentedItem key={c.id} value={c.id}>
              {c.name}
            </SegmentedItem>
          ))}
        </Segmented>
      </Setting>
      <Setting
        title="Install updates automatically"
        about={
          off
            ? 'Needs the updater, which is off on this server.'
            : `Overnight, around 4 AM server time, when ${channelName(status.channel)} has a new version.`
        }
      >
        <Switch
          checked={status.autoUpdate}
          disabled={off}
          onCheckedChange={(enabled) =>
            void run(
              () => setAutoUpdate({ enabled, sessionId: session.sessionId }),
              'Automatic updates couldn’t be changed.',
            )
          }
          aria-label="Install updates automatically"
        />
      </Setting>
    </>
  )
}

/** Where updating stands, and the button for what to do next. */
function UpdateState({ status }: { status: UpdateStatus }) {
  const session = useSession()
  const request = useMutation(api.updates.request)
  const cancel = useMutation(api.updates.cancelRequest)
  const [busy, setBusy] = useState(false)
  const view = updateView(status)
  const stale = updaterStale(status)
  const channel = channelName(status.channel)

  async function ask(kind: 'check' | 'update') {
    setBusy(true)
    try {
      await request({ kind, sessionId: session.sessionId })
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, kind === 'update' ? 'The update couldn’t be started.' : 'Couldn’t check for updates.'))
    }
    setBusy(false)
  }
  const check = (
    <Button size="sm" loading={busy} onClick={() => void ask('check')}>
      Check now
    </Button>
  )

  let body: ReactNode
  let action: ReactNode = null
  let tone: 'plain' | 'good' | 'warn' = 'plain'
  switch (view.kind) {
    case 'off':
      body = (
        <>
          This server’s updater is off, so it’s updated by hand on the server. To update it from here, its operator runs
          the installer again with <code className="font-mono text-[0.92em]">--updater</code>.
        </>
      )
      break
    case 'updating':
      tone = 'good'
      body = (
        <>
          <b className="font-semibold">Updating now.</b> {view.message ?? ''}
          {view.startedAt ? ` Started ${when(view.startedAt)}.` : ''} The server restarts only what changed; this page
          reloads itself once the new version is ready.
        </>
      )
      break
    case 'waiting':
      body = (
        <>{view.request === 'update' ? 'The update starts' : 'The check runs'} as soon as the updater picks it up.</>
      )
      action = (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void cancel({ sessionId: session.sessionId }).catch((e: unknown) =>
              toast(errorMessage(e, 'That couldn’t be cancelled.')),
            )
          }
        >
          Cancel
        </Button>
      )
      break
    case 'failed':
      tone = 'warn'
      body = view.message
      action = (
        <Button size="sm" loading={busy} onClick={() => void ask('update')}>
          Try again
        </Button>
      )
      break
    case 'available':
      tone = 'good'
      body = (
        <>
          <b className="font-semibold">
            An update is available: {shortCommit(view.commit)}, from {date.format(view.committedAt)}
          </b>
          {view.behind > 1 ? ` (${view.behind} changes)` : ''}. {view.subject}
        </>
      )
      action = (
        <Button size="sm" variant="primary" loading={busy} onClick={() => void ask('update')}>
          Update now
        </Button>
      )
      break
    case 'current':
      body = `Up to date with ${channel}. Checked ${when(view.checkedAt)}.`
      action = check
      break
    case 'ahead':
      body =
        view.behind > 0
          ? `This server runs changes ${channel} doesn’t have, so it can’t move to ${channel} without going back. It stays where it is.`
          : `This server is newer than ${channel}. It updates again once ${channel} gets ahead of it.`
      action = check
      break
    case 'unchecked':
      body = `The updater hasn’t looked at ${channel} yet.`
      action = check
      break
  }

  return (
    <div className="border-t border-border py-[15px]">
      <div
        className={cn(
          'flex items-center gap-3 rounded-lg p-3 text-sm shadow-[inset_0_0_0_1px_var(--border)]',
          tone === 'good' ? 'bg-primary-soft' : 'bg-surface-2',
        )}
      >
        <span className={cn('min-w-0 flex-1', tone === 'warn' ? 'text-warning' : 'text-foreground')}>{body}</span>
        {action}
      </div>
      {stale && view.kind !== 'off' ? (
        <p className="mt-2 text-sm text-warning">
          {status.updater
            ? `The updater last checked in ${when(status.updater.seenAt)}. It may be stopped on the server.`
            : 'The updater hasn’t checked in yet. It may not be running on the server.'}
        </p>
      ) : null}
    </div>
  )
}
