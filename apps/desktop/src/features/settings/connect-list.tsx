import { Button } from '@trioditis/ui/button'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { useNetworkHealth, useNetworks } from '~/data/chats.ts'
import { useSession } from '~/lib/session.tsx'

/** A login to start: a network, the way to log in to it, and the account it connects again, if any. */
export type Login = { network: string; flowId: string; reconnect?: string }

/**
 * The networks this server offers, one row for each way to log in to them, for connecting an
 * account. Settings → Accounts shows it, and so does the first-run guide (first-network.tsx) for
 * someone with no account yet. `onInstall` takes an admin to install networks when there are none.
 */
export function ConnectList({ onChoose, onInstall }: { onChoose: (login: Login) => void; onInstall: () => void }) {
  const session = useSession()
  const networks = useNetworks()
  const health = useNetworkHealth()
  const bridgeDown = (network: string) => health?.find((h) => h.network === network)?.bridgeOnline === false

  if (networks && networks.length === 0)
    return session.role === 'admin' ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <p className="min-w-0 flex-[1_1_10rem] text-sm text-muted-foreground">No networks are installed yet.</p>
        <Button size="sm" onClick={onInstall}>
          Install networks
        </Button>
      </div>
    ) : (
      <p className="px-4 py-3 text-sm text-muted-foreground">No networks are installed yet. An admin installs them.</p>
    )

  return (networks ?? []).flatMap((n) =>
    n.flows.map((f) => (
      <Button
        variant="bare"
        key={`${n.network}:${f.id}`}
        type="button"
        onClick={() => onChoose({ network: n.network, flowId: f.id })}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2"
      >
        <NetworkBadge network={n.network} label={n.name} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{n.name}</span>
          <span className="block text-sm text-muted-foreground">
            {f.name}
            {n.maturity === 'stable' ? '' : n.maturity === 'experimental' ? ' · Experimental' : ' · Beta'}
            {bridgeDown(n.network) ? (
              <span className="text-warning"> · The server’s bridge isn’t responding</span>
            ) : null}
          </span>
        </span>
      </Button>
    )),
  )
}
