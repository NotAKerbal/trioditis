import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useMemo, useState } from 'react'
import { bridgeLive, useHeardClock, useNow } from '~/data/bridge-liveness.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Disclosure, Group, Heading, Loading } from './layout.tsx'

type Entry = FunctionReturnType<typeof api.networks.catalog>[number]

/** What a network this server runs no bridge for needs, where it's more than the installer's default. */
function unavailable(entry: Entry) {
  if (entry.network === 'discord') return 'Not available yet: its bridge doesn’t work with Trioditis.'
  if (entry.network === 'telegram') return 'Needs your own API ID and hash: --telegram-api-id and --telegram-api-hash.'
  return null
}

function accounts(count: number) {
  return count === 1 ? '1 account connected' : `${count} accounts connected`
}

/**
 * Admin settings → Networks: install the networks people on this server can connect, and
 * remove them. Every network whose bridge the server runs can be installed; removing one
 * disconnects every account on it.
 */
export function Networks() {
  const session = useSession()
  const { data: rows, isError } = useQuery(convexQuery(api.networks.catalog, {}))
  // A bridge that stops heartbeating is judged down as time passes (bridge-liveness.ts).
  const clock = useHeardClock()
  const now = useNow()
  const catalog = useMemo(
    () =>
      rows?.map((entry) => ({
        ...entry,
        bridgeOnline: bridgeLive(
          entry.bridgeOnline,
          entry.bridgeLastSeenAt,
          entry.bridgeLastSeenAt == null ? undefined : clock.heardAt(entry.network, entry.bridgeLastSeenAt, now),
          now,
        ),
      })),
    [rows, clock, now],
  )
  const install = useMutation(api.networks.install)
  const remove = useMutation(api.networks.remove)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Entry | null>(null)
  // The networks to install fold away once some are installed; the ones this server can't run
  // stay folded until asked for.
  const [browsing, setBrowsing] = useState<boolean | null>(null)
  const [showElsewhere, setShowElsewhere] = useState(false)

  async function run(network: string, action: () => Promise<unknown>, failure: string) {
    setBusy(network)
    try {
      await action()
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, failure))
    }
    setBusy(null)
  }

  function removeNow(entry: Entry) {
    setConfirm(null)
    void run(
      entry.network,
      async () => {
        await remove({ network: entry.network, sessionId: session.sessionId })
        toast(
          entry.accounts
            ? `${entry.name} removed. Disconnecting ${entry.accounts === 1 ? '1 account' : `${entry.accounts} accounts`}…`
            : `${entry.name} removed.`,
        )
      },
      `${entry.name} couldn’t be removed.`,
    )
  }

  const installed = (catalog ?? []).filter((entry) => entry.installed)
  const available = (catalog ?? []).filter((entry) => !entry.installed && entry.bridged)
  const elsewhere = (catalog ?? []).filter((entry) => !entry.installed && !entry.bridged)
  const openAvailable = browsing ?? installed.length === 0

  function row(entry: Entry) {
    // Only what's worth knowing before installing or removing it: a bridge that's down, the
    // accounts a removal would disconnect, and a network that isn't stable yet.
    const status = [
      entry.maturity === 'stable' ? null : entry.maturity === 'experimental' ? 'Experimental' : 'Beta',
      ...(entry.installed
        ? [
            entry.bridgeOnline ? null : 'The server’s bridge for it isn’t responding',
            entry.accounts ? accounts(entry.accounts) : null,
          ]
        : entry.bridged
          ? [entry.accounts ? `Not installed · ${accounts(entry.accounts)}, disconnecting` : null]
          : [unavailable(entry)]),
    ]
      .filter(Boolean)
      .join(' · ')
    return (
      <div key={entry.network} className="px-4 py-3">
        <div className="flex min-h-9 items-center gap-3">
          <NetworkBadge network={entry.network} label={entry.name} size={26} />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{entry.name}</div>
            {status ? (
              <div
                className={cn(
                  'text-sm',
                  entry.installed && !entry.bridgeOnline ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {status}
              </div>
            ) : null}
          </div>
          {entry.installed ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === entry.network}
              disabled={busy !== null}
              onClick={() => setConfirm(entry)}
            >
              Remove
            </Button>
          ) : entry.bridged ? (
            <Button
              size="sm"
              loading={busy === entry.network}
              disabled={busy !== null}
              onClick={() =>
                void run(
                  entry.network,
                  async () => {
                    await install({ network: entry.network, sessionId: session.sessionId })
                    toast(`${entry.name} installed. Members can connect it now.`)
                  },
                  `${entry.name} couldn’t be installed.`,
                )
              }
            >
              Install
            </Button>
          ) : null}
        </div>
        {confirm?.network === entry.network ? (
          <div className="mt-2.5 rounded-lg bg-warning-soft p-3.5 text-sm text-warning-ink">
            {/* Asked every time: the count is a capped estimate, and a removal logs everyone out. */}
            <b className="font-semibold">
              Removing {entry.name} disconnects every account on it, everyone’s
              {entry.accounts ? ` (${accounts(entry.accounts)})` : ''}.
            </b>{' '}
            Their chats stay, but nothing new arrives until it’s installed and they connect again.
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="primary" onClick={() => removeNow(entry)}>
                Remove {entry.name}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <>
      <Heading title="Networks" />
      {catalog ? (
        <>
          <Group title="Installed">
            {installed.length ? (
              installed.map(row)
            ) : (
              <p className="px-4 py-3 text-sm text-muted-foreground">None yet, so nobody can connect a network.</p>
            )}
          </Group>
          {available.length ? (
            <Group>
              <Disclosure open={openAvailable} onOpenChange={setBrowsing}>
                Install a network ({available.length})
              </Disclosure>
              {openAvailable ? available.map(row) : null}
            </Group>
          ) : null}
          {elsewhere.length ? (
            <Group>
              <Disclosure open={showElsewhere} onOpenChange={setShowElsewhere}>
                Not on this server ({elsewhere.length})
              </Disclosure>
              {showElsewhere ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">
                  To add these, rerun the installer:{' '}
                  <code className="font-mono">deploy/install/install.sh --networks all</code>
                </p>
              ) : null}
              {showElsewhere ? elsewhere.map(row) : null}
            </Group>
          ) : null}
        </>
      ) : (
        <Loading failed={isError} />
      )}
    </>
  )
}
