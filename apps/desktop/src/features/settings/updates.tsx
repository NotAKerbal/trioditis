import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { useEffect, useState, type ReactNode } from 'react'
import {
  CHANNELS,
  channelName,
  runningVersion,
  shortCommit,
  updaterStale,
  UPDATER_STALE_MS,
  updateView,
  when,
  type Channel,
  type UpdateStatus,
} from '~/data/updates.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Heading, Loading, Setting } from './layout.tsx'

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** Admin settings → Updates: the release channel, automatic updates, and updating now. */
export function Updates() {
  const { data: status, isError } = useQuery(convexQuery(api.updates.status, {}))
  return (
    <>
      <Heading title="Updates" />
      {status ? <UpdateSettings status={status} /> : <Loading failed={isError} />}
    </>
  )
}

function UpdateSettings({ status }: { status: UpdateStatus }) {
  const session = useSession()
  const setChannel = useMutation(api.updates.setChannel)
  const setAutoUpdate = useMutation(api.updates.setAutoUpdate)
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
      <UpdateState status={status} />
      {/* Only nightly's line is a warning worth keeping in view. */}
      <Setting
        title="Channel"
        about={status.channel === 'nightly' ? CHANNELS.find((c) => c.id === 'nightly')!.about : undefined}
      >
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
      <Setting title="Install updates automatically" about={off ? undefined : 'Around 4 AM server time.'}>
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

/** The version this server runs, where updating stands, and the button for what to do next. */
function UpdateState({ status }: { status: UpdateStatus }) {
  const session = useSession()
  const request = useMutation(api.updates.request)
  const cancel = useMutation(api.updates.cancelRequest)
  const [busy, setBusy] = useState(false)
  // Renders again when the updater's last report goes stale: with no new report, nothing else
  // would, and the warning would never show.
  const [, recheck] = useState(0)
  const seenAt = status.updater?.seenAt
  useEffect(() => {
    if (seenAt === undefined) return
    const wait = seenAt + UPDATER_STALE_MS - Date.now() + 1000
    if (wait <= 0) return
    const timer = setTimeout(() => recheck((n) => n + 1), wait)
    return () => clearTimeout(timer)
  }, [seenAt])
  const version = runningVersion(status)
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
  let warn = false
  switch (view.kind) {
    case 'off':
      body = (
        <>
          The updater is off. To update from here, rerun the installer with{' '}
          <code className="font-mono text-[0.92em]">--updater</code>.
        </>
      )
      break
    case 'updating':
      body = (
        <>
          <b className="font-semibold text-foreground">Updating now.</b> {view.message ?? ''}
          {view.startedAt ? ` Started ${when(view.startedAt)}.` : ''}
        </>
      )
      break
    case 'waiting':
      body = `${view.request === 'update' ? 'The update' : 'The check'} is waiting for the updater.`
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
      warn = true
      body = view.message
      action = (
        <Button size="sm" loading={busy} onClick={() => void ask('update')}>
          Try again
        </Button>
      )
      break
    case 'available':
      body = (
        <>
          <b className="font-semibold text-foreground">
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
      body = `Up to date. Checked ${when(view.checkedAt)}.`
      action = check
      break
    case 'ahead':
      body =
        view.behind > 0
          ? `It runs changes ${channel} doesn’t have, so it stays where it is.`
          : `Newer than ${channel}. It updates again once ${channel} passes it.`
      action = check
      break
    case 'unchecked':
      body = 'Not checked yet.'
      action = check
      break
  }

  return (
    <Setting
      title={
        version
          ? `Version ${shortCommit(version.commit)}${version.committedAt ? `, from ${date.format(version.committedAt)}` : ''}`
          : 'Version unknown'
      }
      about={
        <>
          <span className={cn(warn && 'text-warning')}>{body}</span>
          {stale && view.kind !== 'off' ? (
            <span className="mt-0.5 block text-warning">
              {status.updater
                ? `The updater last checked in ${when(status.updater.seenAt)}. It may be stopped on the server.`
                : 'The updater hasn’t checked in yet. It may not be running on the server.'}
            </span>
          ) : null}
        </>
      }
    >
      {action}
    </Setting>
  )
}
