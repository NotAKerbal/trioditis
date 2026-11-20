import type { api } from '@trioditis/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { listTime } from './format.ts'

// What Admin settings → Updates shows, worked out from updates.status. The updater on the server
// does the work and reports in; see docs/deploy.md, Updates.

export type UpdateStatus = FunctionReturnType<typeof api.updates.status>
export type Channel = UpdateStatus['channel']
export type ReleaseNote = NonNullable<NonNullable<UpdateStatus['updater']>['installed']>['notes'][number]
export type ReleaseLabel = ReleaseNote['label']

/** The updater reports every ten minutes; after this long without a word, it's taken as stopped. */
export const UPDATER_STALE_MS = 25 * 60 * 1000

export const CHANNELS: { id: Channel; name: string; about: string }[] = [
  { id: 'stable', name: 'Stable', about: 'Releases that have been tried on nightly first.' },
  { id: 'nightly', name: 'Nightly', about: 'Every change as soon as it’s in. Newest, and sometimes broken.' },
]

export const channelName = (channel: Channel) => CHANNELS.find((c) => c.id === channel)!.name

/** Release notes' labels, in the order they're shown. */
export const RELEASE_LABELS: { id: ReleaseLabel; name: string }[] = [
  { id: 'new', name: 'New' },
  { id: 'improved', name: 'Improved' },
  { id: 'fixed', name: 'Fixed' },
  { id: 'security', name: 'Security' },
  { id: 'internal', name: 'Internal' },
]

/** Release notes grouped by label, in RELEASE_LABELS' order, each keeping the order it came in. */
export function groupNotes(notes: ReleaseNote[]) {
  return RELEASE_LABELS.map(({ id, name }) => ({
    label: id,
    name,
    texts: notes.filter((n) => n.label === id).map((n) => n.text),
  })).filter((group) => group.texts.length > 0)
}

export type UpdateView =
  /** The server has no updater: it's updated by hand on the server. */
  | { kind: 'off' }
  | { kind: 'updating'; startedAt: number | undefined; message: string | undefined }
  /** A request the updater hasn't taken up yet. */
  | { kind: 'waiting'; request: 'check' | 'update' }
  | { kind: 'failed'; message: string }
  | {
      kind: 'available'
      commit: string
      committedAt: number
      subject: string
      behind: number
      notes: ReleaseNote[]
    }
  | { kind: 'current'; checkedAt: number }
  /** The server runs commits the channel doesn't have (it was on nightly, say), so it stays put. */
  | { kind: 'ahead'; ahead: number; behind: number }
  /** The updater hasn't looked at this channel yet. */
  | { kind: 'unchecked' }

export function updateView(status: UpdateStatus): UpdateView {
  const { updater, request } = status
  if (!status.updaterConfigured) return { kind: 'off' }
  if (updater?.state === 'updating') return { kind: 'updating', startedAt: updater.startedAt, message: updater.message }
  if (request) return { kind: 'waiting', request: request.kind }
  if (updater?.state === 'failed') return { kind: 'failed', message: updater.message ?? 'The last update failed.' }
  const latest = updater?.latest
  if (!latest || latest.channel !== status.channel) return { kind: 'unchecked' }
  if (latest.ahead > 0) return { kind: 'ahead', ahead: latest.ahead, behind: latest.behind }
  if (latest.behind > 0) {
    const { commit, committedAt, subject, behind } = latest
    return { kind: 'available', commit, committedAt, subject, behind, notes: latest.notes ?? [] }
  }
  return { kind: 'current', checkedAt: latest.checkedAt }
}

/**
 * The release notes of the update that put this server on the version it runs, if the updater
 * installed it: what's new. Empty once the server moves on, or was updated by hand. The deployed
 * functions' version decides where it's known, since an install by hand with the updater off
 * leaves the updater's last report behind.
 */
export function whatsNew(status: UpdateStatus): ReleaseNote[] {
  const installed = status.updater?.installed
  const deployed = status.version && status.version !== 'unknown' ? status.version : undefined
  const running = deployed ?? runningVersion(status)?.commit
  return installed && installed.to === running ? installed.notes : []
}

/** Whether the updater has gone quiet: it may be stopped, or the server down. */
export function updaterStale(status: UpdateStatus, now = Date.now()) {
  return status.updaterConfigured && (!status.updater || now - status.updater.seenAt > UPDATER_STALE_MS)
}

/** The version shown for this server: the commit the updater says it runs, or the installer's. */
export function runningVersion(status: UpdateStatus): { commit: string; committedAt?: number } | null {
  if (status.updater?.current) return status.updater.current
  return status.version && status.version !== 'unknown' ? { commit: status.version } : null
}

export const shortCommit = (commit: string) => commit.slice(0, 7)

/** "at 9:41" today, "on Tue" this week, "on Nov 3" before that. */
export function when(ms: number, now = Date.now()) {
  return `${new Date(ms).toDateString() === new Date(now).toDateString() ? 'at' : 'on'} ${listTime(ms, now)}`
}

/**
 * Whether this page's build is older than the server's, from the commit each was built from:
 * the build's own (VITE_TRIODITIS_VERSION) and the server's (server.info). Unknown on either
 * side (a dev server, a preview, an install from outside git) never counts.
 */
export function buildOutdated(build: string | undefined, server: string | null | undefined) {
  const known = (v: string | null | undefined): v is string => !!v && v !== 'unknown'
  return known(build) && known(server) && build !== server
}
