import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { useAction, useMutation } from 'convex/react'
import { useEffect, useState } from 'react'
import { accountLabels, type AccountLabel } from '~/data/account-label.ts'
import { networkName, useAccounts, useNetworkHealth, useNetworks, useServerInfo } from '~/data/chats.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { accountView, disconnectFailure, disconnectResult, GROUP_TITLES, type AccountGroup } from './account-groups.ts'
import { Disclosure, Group, Heading, Setting } from './layout.tsx'
import { LoginStepper } from './login-stepper.tsx'

type Login = { network: string; flowId: string; reconnect?: string }

/** Settings → Accounts: the person's accounts, by how they're doing, and connecting more. */
export function Accounts({ connect }: { connect: boolean }) {
  const session = useSession()
  const networks = useNetworks()
  const accounts = useAccounts()
  const health = useNetworkHealth()
  const server = useServerInfo()
  const logout = useMutation(api.logins.logout)
  const [connecting, setConnecting] = useState<Login | null>(null)
  const [confirmRisk, setConfirmRisk] = useState<Login | null>(null)
  // The account whose login methods are open to reconnect it, and the one asked to disconnect.
  const [choosing, setChoosing] = useState<Id<'networkAccounts'> | null>(null)
  const [confirmDisconnect, setConfirmDisconnect] = useState<Id<'networkAccounts'> | null>(null)
  const [disconnecting, setDisconnecting] = useState<Id<'networkAccounts'> | null>(null)
  // The networks to connect stay folded away until asked for, unless there's no account yet or
  // the person came here to connect one ("Connect a network" in the menus).
  const [browsing, setBrowsing] = useState<boolean | null>(connect || null)
  // Back and forward can bring `connect` in or take it away while Accounts stays open.
  useEffect(() => setBrowsing(connect || null), [connect])
  const open = browsing ?? accounts?.length === 0

  const labels = accountLabels((accounts ?? []).map((a) => ({ id: a._id, network: a.network, hint: a.hint })))
  const label = (id: Id<'networkAccounts'>, network: string): AccountLabel =>
    labels.get(id) ?? { name: networkName(network), detail: null, full: networkName(network) }
  const bridgeDown = (network: string) => health?.find((h) => h.network === network)?.bridgeOnline === false
  const offered = (network: string) => networks?.find((n) => n.network === network)

  /** Opens the stepper for a login method, after the terms warning where the network has one. */
  function begin(login: Login) {
    setChoosing(null)
    if (offered(login.network)?.termsRisk) setConfirmRisk(login)
    else setConnecting(login)
  }

  async function disconnect(id: Id<'networkAccounts'>, name: string) {
    setConfirmDisconnect(null)
    setDisconnecting(id)
    try {
      toast(disconnectResult(await logout({ networkAccountId: id }), name))
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(disconnectFailure(e, name))
    }
    setDisconnecting(null)
  }

  if (connecting)
    return (
      <LoginStepper
        network={connecting.network}
        flowId={connecting.flowId}
        {...(connecting.reconnect ? { reconnect: connecting.reconnect } : {})}
        onClose={() => setConnecting(null)}
      />
    )

  const views = (accounts ?? []).map((a) => ({ account: a, view: accountView(a, bridgeDown(a.network)) }))
  const groups: AccountGroup[] = ['attention', 'connected', 'loggedOut']

  const riskWarning = (login: Login) => (
    <div className="bg-warning-soft px-4 py-3.5 text-sm text-warning-ink last:rounded-b-xl">
      {/* Every network marked termsRisk is one whose terms forbid unofficial clients like this one. */}
      <b className="font-semibold">
        Connecting {networkName(login.network)} this way is against its terms, and can get the account banned.
      </b>
      <div className="mt-2.5 flex gap-2">
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setConnecting(login)
            setConfirmRisk(null)
          }}
        >
          I understand, connect
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirmRisk(null)}>
          Cancel
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <Heading title="Accounts" />
      {groups.map((group) => {
        const rows = views.filter((row) => row.view.group === group)
        if (!rows.length) return null
        return (
          <Group key={group} title={GROUP_TITLES[group]}>
            {rows.map(({ account: a, view }) => {
              const name = label(a._id, a.network)
              const methods = offered(a.network)?.flows ?? []
              return (
                <div key={a._id}>
                  <div className="flex min-h-[60px] items-center gap-3 px-4 py-3">
                    <NetworkBadge network={a.network} label={name.name} size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">
                        {name.name}
                        {name.detail ? (
                          <span className="font-normal text-muted-foreground"> · {name.detail}</span>
                        ) : null}
                      </div>
                      {view.note ? (
                        <div className={cn('text-sm', view.warn ? 'text-warning' : 'text-muted-foreground')}>
                          {view.note}
                        </div>
                      ) : view.reconnect && !methods.length ? (
                        <div className="text-sm text-muted-foreground">This server doesn’t offer it any more.</div>
                      ) : null}
                    </div>
                    {view.reconnect && methods.length ? (
                      <Button
                        size="sm"
                        onClick={() =>
                          methods.length === 1
                            ? begin({ network: a.network, flowId: methods[0]!.id, reconnect: name.full })
                            : setChoosing(choosing === a._id ? null : a._id)
                        }
                        aria-expanded={methods.length > 1 ? choosing === a._id : undefined}
                      >
                        Reconnect
                      </Button>
                    ) : null}
                    {view.disconnect ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={disconnecting === a._id}
                        disabled={disconnecting !== null}
                        onClick={() => setConfirmDisconnect(a._id)}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                  {choosing === a._id
                    ? methods.map((f) => (
                        <Button
                          variant="bare"
                          key={f.id}
                          type="button"
                          onClick={() => begin({ network: a.network, flowId: f.id, reconnect: name.full })}
                          className="flex w-full items-center gap-3 py-2.5 pr-4 pl-[54px] text-left text-sm hover:bg-surface-2"
                        >
                          {f.name}
                        </Button>
                      ))
                    : null}
                  {confirmRisk?.reconnect === name.full && confirmRisk.network === a.network
                    ? riskWarning(confirmRisk)
                    : null}
                  {confirmDisconnect === a._id ? (
                    <div className="mx-4 mb-3 rounded-lg bg-warning-soft p-3.5 text-sm text-warning-ink">
                      <b className="font-semibold">Disconnect {name.full}?</b> Its chats stay, but nothing new arrives
                      until you connect it again.
                      <div className="mt-2.5 flex gap-2">
                        <Button size="sm" variant="primary" onClick={() => void disconnect(a._id, name.full)}>
                          Disconnect {name.full}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmDisconnect(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </Group>
        )
      })}

      <Group>
        <Disclosure open={open} onOpenChange={setBrowsing}>
          Connect a network
        </Disclosure>
        {open && confirmRisk && !confirmRisk.reconnect ? riskWarning(confirmRisk) : null}
        {open
          ? (networks ?? []).flatMap((n) =>
              n.flows.map((f) => (
                <Button
                  variant="bare"
                  key={`${n.network}:${f.id}`}
                  type="button"
                  onClick={() => begin({ network: n.network, flowId: f.id })}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left last:rounded-b-xl hover:bg-surface-2"
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
          : null}
        {open && networks && networks.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {session.role === 'admin'
              ? 'No networks are installed yet. Install them in Admin settings → Networks.'
              : 'No networks are installed yet. An admin installs them.'}
          </p>
        ) : null}
      </Group>
      {server?.demo ? (
        <Group>
          <Setting title="Demo chats">
            <DemoSeed />
          </Setting>
        </Group>
      ) : null}
    </>
  )
}

/**
 * A demo server can fill an account with made-up chats, on accounts no bridge runs, to try the
 * app without connecting a real one. Shown only where server.info says it's a demo.
 */
function DemoSeed() {
  const session = useSession()
  const seed = useAction(api.demo.seedForMe)
  const [busy, setBusy] = useState(false)
  return (
    <Button
      size="sm"
      aria-label="Load demo chats"
      loading={busy}
      onClick={async () => {
        setBusy(true)
        try {
          const { seeded } = await seed({ sessionId: session.sessionId })
          toast(seeded ? 'Demo chats added.' : 'Your account already has the demo chats.')
        } catch (e) {
          if (sessionChanged(e)) return window.location.reload()
          toast(errorMessage(e, 'This server doesn’t offer demo chats.'))
        }
        setBusy(false)
      }}
    >
      Load
    </Button>
  )
}
