import { api } from '@trioditis/backend/api'
import { Badge } from '@trioditis/ui/badge'
import { Button } from '@trioditis/ui/button'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import type { FunctionReturnType } from 'convex/server'
import { useMutation } from 'convex/react'
import { useState } from 'react'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Heading } from './layout.tsx'

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
  const { data: catalog } = useQuery(convexQuery(api.networks.catalog, {}))
  const install = useMutation(api.networks.install)
  const remove = useMutation(api.networks.remove)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Entry | null>(null)

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
        const { disconnecting } = await remove({ network: entry.network, sessionId: session.sessionId })
        toast(
          disconnecting
            ? `${entry.name} removed. Disconnecting ${disconnecting === 1 ? '1 account' : `${disconnecting} accounts`}…`
            : `${entry.name} removed.`,
        )
      },
      `${entry.name} couldn’t be removed.`,
    )
  }

  const installed = (catalog ?? []).filter((entry) => entry.installed)
  const available = (catalog ?? []).filter((entry) => !entry.installed && entry.bridged)
  const elsewhere = (catalog ?? []).filter((entry) => !entry.installed && !entry.bridged)

  function row(entry: Entry) {
    const status = entry.installed
      ? [
          entry.bridgeOnline ? 'Running' : 'The server’s bridge for it isn’t running',
          entry.accounts ? accounts(entry.accounts) : 'No accounts connected',
        ].join(' · ')
      : entry.bridged
        ? entry.accounts
          ? `Not installed · ${accounts(entry.accounts)}, disconnecting`
          : 'Ready to install'
        : unavailable(entry)
    return (
      <div key={entry.network} className="border-t border-border py-[11px]">
        <div className="flex items-center gap-3">
          <NetworkBadge network={entry.network} label={entry.name} size={26} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 font-semibold">
              {entry.name}
              {entry.maturity !== 'stable' ? (
                <Badge variant="outline">{entry.maturity === 'experimental' ? 'exp' : 'beta'}</Badge>
              ) : null}
            </div>
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
              onClick={() => (entry.accounts ? setConfirm(entry) : removeNow(entry))}
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
            <b className="font-semibold">
              Removing {entry.name} disconnects {entry.accounts === 1 ? '1 account' : `all ${entry.accounts} accounts`}{' '}
              on it, everyone’s.
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
      <Heading
        title="Networks"
        lead="The networks people on this server can connect. Install one and everyone can connect their own account on it."
      />
      {catalog ? (
        <>
          <h3 className="mt-2 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
            Installed
          </h3>
          {installed.length ? (
            installed.map(row)
          ) : (
            <p className="border-t border-border py-3 text-sm text-muted-foreground">
              No networks installed yet, so nobody can connect one. Install one below.
            </p>
          )}
          <h3 className="mt-6 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
            Available
          </h3>
          {available.length ? (
            available.map(row)
          ) : (
            <p className="border-t border-border py-3 text-sm text-muted-foreground">
              Every network this server runs is installed.
            </p>
          )}
          {elsewhere.length ? (
            <>
              <h3 className="mt-6 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
                Not on this server
              </h3>
              <p className="mb-2 text-sm text-muted-foreground">
                This server doesn’t run a bridge for these. Whoever runs it adds them by running the installer again:{' '}
                <code className="font-mono">deploy/install/install.sh --networks all</code>.
              </p>
              {elsewhere.map(row)}
            </>
          ) : null}
        </>
      ) : null}
    </>
  )
}
