import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import {
  generateRecoveryKey,
  newPasswordParams,
  passwordKey,
  toBase64Url,
  wrapIdentityKey,
  type RecoveryKey,
} from '@trioditis/crypto'
import { Badge } from '@trioditis/ui/badge'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useAction, useMutation } from 'convex/react'
import { Check, Copy, Eye, KeyRound, Plug, Plus, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { networkName, useAccounts, useNetworkHealth, useNetworks, useSidebarLayout } from '~/data/chats.ts'
import { authClient, derivedAuthPassword } from '~/lib/auth-client.ts'
import { config } from '~/lib/config.ts'
import { errorMessage } from '~/lib/errors.ts'
import { setPref, usePrefs } from '~/lib/prefs.ts'
import { proveKey } from '~/lib/proof.ts'
import { useSession } from '~/lib/session.tsx'
import { LoginStepper } from './login-stepper.tsx'

export const SETTINGS_SECTIONS = [
  { id: 'appearance', name: 'Appearance', icon: <Eye /> },
  { id: 'accounts', name: 'Accounts', icon: <Plug /> },
  { id: 'members', name: 'Members', icon: <Users />, admin: true },
  { id: 'keys', name: 'Keys and devices', icon: <KeyRound /> },
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']

/** The settings panel. The gear and the account menu open it; its section is in the URL. */
export function SettingsDialog({
  section,
  onSectionChange,
}: {
  section: SettingsSection | undefined
  onSectionChange: (s: SettingsSection | undefined) => void
}) {
  const session = useSession()
  const sections = SETTINGS_SECTIONS.filter((s) => !('admin' in s) || session.role === 'admin')
  const current = sections.find((s) => s.id === section) ?? sections[0]!
  return (
    <Dialog open={!!section} onOpenChange={(open) => !open && onSectionChange(undefined)}>
      <DialogContent className="flex h-[620px] w-[min(900px,calc(100vw-32px))]" aria-describedby={undefined}>
        <nav
          className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-border bg-rail px-2.5 py-[18px]"
          aria-label="Settings sections"
        >
          <DialogTitle className="mx-2 mb-3.5 text-md">Settings</DialogTitle>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-current={s.id === current.id ? 'page' : undefined}
              onClick={() => onSectionChange(s.id)}
              className={cn(
                'flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-left font-medium text-muted-foreground hover:bg-rail-hover hover:text-foreground [&_svg]:size-4',
                s.id === current.id &&
                  'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--border),var(--elevation-sm)]',
              )}
            >
              {s.icon}
              {s.name}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-[22px] pb-7">
          {current.id === 'appearance' ? (
            <Appearance />
          ) : current.id === 'accounts' ? (
            <Accounts />
          ) : current.id === 'members' ? (
            <Members />
          ) : (
            <Keys />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Heading({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <h2 className="pr-10 text-lg font-bold tracking-[-0.015em]">{title}</h2>
      <DialogDescription className="mt-1 mb-3.5">{lead}</DialogDescription>
    </>
  )
}

function Setting({
  title,
  about,
  children,
  column,
}: {
  title: string
  about: string
  children: ReactNode
  column?: boolean
}) {
  return (
    <div className={cn('border-t border-border py-[15px]', column ? 'block' : 'flex items-center gap-[18px]')}>
      <div className="min-w-0 flex-1">
        <b className="block font-semibold">{title}</b>
        <span className="mt-0.5 block text-sm text-muted-foreground">{about}</span>
      </div>
      {children}
    </div>
  )
}

function Appearance() {
  const prefs = usePrefs()
  const [layout, setLayout] = useSidebarLayout()
  const options = [
    {
      id: 'simple' as const,
      name: 'Simple',
      about: 'Every chat in one list, newest first. Nothing else in the way.',
      drawing: <MiniSimple />,
    },
    {
      id: 'focused' as const,
      name: 'Focused',
      about: 'Unread on top. Read, snoozed, scheduled and archived chats fold away until you open them.',
      drawing: <MiniFocused />,
    },
  ]
  return (
    <>
      <Heading
        title="Appearance"
        lead="How Trioditis looks. The sidebar layout follows you to your other devices; the rest is for this device."
      />
      <Setting title="Sidebar layout" about="How the chat list is organized. You can switch at any time." column>
        <div className="mt-3 grid grid-cols-2 gap-3" role="radiogroup" aria-label="Sidebar layout">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={layout === o.id}
              onClick={() => setLayout(o.id)}
              className={cn(
                'grid gap-1.5 rounded-xl p-3 text-left shadow-[0_0_0_1px_var(--border)] hover:bg-surface-2',
                layout === o.id && 'bg-primary-soft shadow-[0_0_0_2px_var(--accent-ring)] hover:bg-primary-soft',
              )}
            >
              {o.drawing}
              <span
                className={cn('flex items-center justify-between font-bold', layout === o.id && 'text-primary-ink')}
              >
                {o.name} {layout === o.id ? <Check className="size-4" /> : null}
              </span>
              <span className="text-sm text-muted-foreground">{o.about}</span>
            </button>
          ))}
        </div>
      </Setting>
      <Setting title="Theme" about="Follow this device, or always use light or dark.">
        <Segmented
          value={prefs.theme}
          onValueChange={(v) => setPref('theme', v as 'system' | 'light' | 'dark')}
          className="w-[240px]"
          aria-label="Theme"
        >
          <SegmentedItem value="system">System</SegmentedItem>
          <SegmentedItem value="light">Light</SegmentedItem>
          <SegmentedItem value="dark">Dark</SegmentedItem>
        </Segmented>
      </Setting>
      <Setting title="Message previews" about="Show a second line under each chat in the list.">
        <Switch
          checked={prefs.previews}
          onCheckedChange={(v) => setPref('previews', v)}
          aria-label="Message previews"
        />
      </Setting>
      <Setting title="Network badges" about="Show which network each chat is on, on its picture.">
        <Switch
          checked={prefs.networkBadges}
          onCheckedChange={(v) => setPref('networkBadges', v)}
          aria-label="Network badges"
        />
      </Setting>
    </>
  )
}

function MiniRow({ unread }: { unread?: boolean }) {
  return (
    <div className="flex h-[13px] shrink-0 items-center gap-1 rounded-[4px] bg-surface px-1.5 shadow-[0_0_0_1px_var(--border)]">
      <i className={cn('size-1.5 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-border-strong')} />
      <em className={cn('h-[3px] flex-1 rounded-sm', unread ? 'bg-subtle-foreground' : 'bg-border')} />
    </div>
  )
}
function MiniDivider({ label }: { label: string }) {
  return (
    <div className="mx-0.5 flex h-2.5 shrink-0 items-center gap-1 text-[7.5px] font-semibold text-subtle-foreground after:h-px after:flex-1 after:bg-border-strong">
      {label}
    </div>
  )
}
function MiniFocused() {
  return (
    <div
      className="flex h-32 flex-col gap-1 overflow-hidden rounded-lg bg-rail p-2 shadow-[inset_0_0_0_1px_var(--border)]"
      aria-hidden
    >
      <div className="mx-0.5 text-[7.5px] font-bold tracking-[0.06em] text-subtle-foreground">UNREAD</div>
      <MiniRow unread />
      <MiniRow unread />
      <MiniRow unread />
      <MiniDivider label="Read" />
      <MiniDivider label="Snoozed" />
      <MiniDivider label="Scheduled" />
      <MiniDivider label="Archived" />
    </div>
  )
}
function MiniSimple() {
  return (
    <div
      className="flex h-32 flex-col gap-1 overflow-hidden rounded-lg bg-rail p-2 shadow-[inset_0_0_0_1px_var(--border)]"
      aria-hidden
    >
      <MiniRow unread />
      <MiniRow unread />
      <MiniRow />
      <MiniRow unread />
      <MiniRow />
      <MiniRow />
      <MiniRow />
    </div>
  )
}

const ACCOUNT_STATE: Record<string, { text: string; warn?: boolean }> = {
  CONNECTED: { text: 'Connected' },
  CONNECTING: { text: 'Connecting…' },
  TRANSIENT_DISCONNECT: { text: 'Reconnecting…', warn: true },
  BAD_CREDENTIALS: { text: 'Signed out by the network. Reconnect it.', warn: true },
  UNKNOWN_ERROR: { text: 'Something went wrong with this account.', warn: true },
  LOGGED_OUT: { text: 'Logged out', warn: true },
}

function Accounts() {
  const networks = useNetworks()
  const accounts = useAccounts()
  const health = useNetworkHealth()
  const logout = useMutation(api.logins.logout)
  const [connecting, setConnecting] = useState<{ network: string; flowId: string } | null>(null)
  const [confirmRisk, setConfirmRisk] = useState<{ network: string; flowId: string } | null>(null)

  if (connecting)
    return <LoginStepper network={connecting.network} flowId={connecting.flowId} onClose={() => setConnecting(null)} />

  return (
    <>
      <Heading
        title="Accounts"
        lead="The network accounts this server bridges for you. Each one you connect brings its chats into your list."
      />
      {accounts?.length ? (
        accounts.map((a) => {
          const state = ACCOUNT_STATE[a.state] ?? { text: a.state }
          const bridgeDown = health?.find((h) => h.network === a.network)?.bridgeOnline === false
          return (
            <div key={a._id} className="flex items-center gap-3 border-t border-border py-[11px]">
              <NetworkBadge network={a.network} label={networkName(a.network)} size={26} />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{networkName(a.network)}</div>
                <div
                  className={cn(
                    'text-sm',
                    state.warn || bridgeDown || a.logoutError ? 'text-warning' : 'text-muted-foreground',
                  )}
                >
                  {a.logoutPending
                    ? 'Disconnecting…'
                    : a.logoutError
                      ? 'It couldn’t be disconnected. Try again.'
                      : bridgeDown
                        ? 'The server’s bridge for this network isn’t running.'
                        : state.text}
                </div>
              </div>
              {a.state === 'BAD_CREDENTIALS' || a.state === 'LOGGED_OUT' ? (
                <Button
                  size="sm"
                  onClick={() =>
                    setConnecting({
                      network: a.network,
                      flowId: networks?.find((n) => n.network === a.network)?.flows[0]?.id ?? '',
                    })
                  }
                >
                  Reconnect
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={a.logoutPending}
                onClick={() =>
                  void logout({ networkAccountId: a._id }).then(
                    () => toast(`Disconnecting ${networkName(a.network)}…`),
                    (e: unknown) => toast(errorMessage(e, 'That account couldn’t be disconnected.')),
                  )
                }
              >
                Disconnect
              </Button>
            </div>
          )
        })
      ) : (
        <p className="border-t border-border py-4 text-sm text-muted-foreground">No accounts connected yet.</p>
      )}

      <h3 className="mt-6 mb-2 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        Connect a network
      </h3>
      {config.environment !== 'production' ? <DemoSeed /> : null}
      {confirmRisk ? (
        <div className="mb-3 rounded-lg bg-warning-soft p-3.5 text-sm text-warning-ink">
          <b className="font-semibold">
            Connecting {networkName(confirmRisk.network)} uses your browser cookies or a token.
          </b>{' '}
          The network’s terms don’t allow that, and it can get the account banned.
          <div className="mt-2.5 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setConnecting(confirmRisk)
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
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {(networks ?? []).flatMap((n) =>
          n.flows.map((f) => (
            <button
              key={`${n.network}:${f.id}`}
              type="button"
              onClick={() =>
                n.termsRisk
                  ? setConfirmRisk({ network: n.network, flowId: f.id })
                  : setConnecting({ network: n.network, flowId: f.id })
              }
              className="flex items-center gap-2.5 rounded-lg p-2.5 text-left shadow-[0_0_0_1px_var(--border)] hover:bg-surface-2"
            >
              <NetworkBadge network={n.network} label={n.name} size={24} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 font-semibold">
                  {n.name}{' '}
                  {n.maturity !== 'stable' ? (
                    <Badge variant="outline">{n.maturity === 'experimental' ? 'exp' : 'beta'}</Badge>
                  ) : null}
                </span>
                <span className="block truncate text-sm text-muted-foreground">{f.name}</span>
              </span>
              <Plus className="size-4 text-subtle-foreground" />
            </button>
          )),
        )}
      </div>
      {networks && networks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This server doesn’t enable any networks yet. Its admin chooses them.
        </p>
      ) : null}
    </>
  )
}

/**
 * Preview and nightly servers can fill an account with made-up chats on a fake network, to try
 * the app without connecting a real one. The server refuses this everywhere else.
 */
function DemoSeed() {
  const seed = useAction(api.demo.seedForMe)
  const [busy, setBusy] = useState(false)
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg bg-surface-2 p-3 text-sm shadow-[inset_0_0_0_1px_var(--border)]">
      <span className="flex-1 text-muted-foreground">
        This is a {config.environment} server. You can fill your account with made-up demo chats.
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const { seeded } = await seed({})
            toast(seeded ? 'Demo chats added.' : 'Your account already has the demo chats.')
          } catch (e) {
            toast(errorMessage(e, 'This server doesn’t offer demo chats.'))
          }
          setBusy(false)
        }}
      >
        Load demo chats
      </Button>
    </div>
  )
}

function Members() {
  const invite = useMutation(api.members.invite)
  const revoke = useMutation(api.members.revokeInvitation)
  const { data: invitations } = useQuery(convexQuery(api.members.invitations, {}))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  return (
    <>
      <Heading
        title="Members"
        lead="Who can use this server. Everyone signs up from an invitation link you share; they connect their own networks."
      />
      <form
        className="flex items-end gap-2 border-t border-border pt-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            const { token } = await invite({ email, role })
            setLink(
              `${window.location.origin}/invite?${new URLSearchParams({ token, email: email.trim().toLowerCase() })}`,
            )
            setCopied(false)
            setEmail('')
          } catch (err) {
            toast(errorMessage(err, 'That invitation couldn’t be made.'))
          }
          setBusy(false)
        }}
      >
        <label className="flex-1">
          <span className="mb-1.5 block text-sm font-semibold">Email</span>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <Segmented
          value={role}
          onValueChange={(v) => setRole(v as 'member' | 'admin')}
          className="mb-[3px] w-[160px]"
          aria-label="Role"
        >
          <SegmentedItem value="member">Member</SegmentedItem>
          <SegmentedItem value="admin">Admin</SegmentedItem>
        </Segmented>
        <Button type="submit" variant="primary" loading={busy}>
          Invite
        </Button>
      </form>
      {link ? (
        <div className="mt-3 rounded-lg bg-surface-2 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
          <p className="mb-2 text-sm text-muted-foreground">
            Send them this link. It works once, for a week, and won’t be shown again.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={link}
              className="font-mono text-sm"
              onFocus={(e) => e.target.select()}
              aria-label="Invitation link"
            />
            <Button
              onClick={() =>
                navigator.clipboard.writeText(link).then(
                  () => setCopied(true),
                  () => toast('Copying didn’t work here. Select the link and copy it.'),
                )
              }
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}
      <h3 className="mt-6 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        Invitations
      </h3>
      {(invitations ?? []).map((inv) => (
        <div key={inv._id} className="flex items-center gap-3 border-t border-border py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{inv.email}</div>
            <div className="text-sm text-muted-foreground">
              {inv.role === 'admin' ? 'Admin' : 'Member'} ·{' '}
              {inv.acceptedAt ? 'Joined' : inv.expiresAt < Date.now() ? 'Expired' : 'Waiting'}
            </div>
          </div>
          {!inv.acceptedAt ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void revoke({ invitationId: inv._id as Id<'invitations'> }).catch((e: unknown) =>
                  toast(errorMessage(e, 'That invitation couldn’t be revoked.')),
                )
              }
            >
              Revoke
            </Button>
          ) : null}
        </div>
      ))}
      {invitations?.length === 0 ? (
        <p className="border-t border-border py-3 text-sm text-muted-foreground">No invitations yet.</p>
      ) : null}
    </>
  )
}

function Keys() {
  const session = useSession()
  const { data: auth } = authClient.useSession()
  const { data: identity } = useQuery(convexQuery(api.keys.identity, {}))
  const putBackup = useMutation(api.keys.putBackup)
  const changePasswordAction = useAction(api.account.changePassword)
  const [recovery, setRecovery] = useState<RecoveryKey | null>(null)
  const [saved, setSaved] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState<'recovery' | 'password' | 'passkey' | null>(null)
  // Replacing a backup names the revision it replaces, so two devices can't overwrite each other.
  const revisionOf = (kind: 'password' | 'recovery') => identity?.backups.find((b) => b.kind === kind)?.revision ?? 0

  async function saveRecovery() {
    if (!recovery) return
    setBusy('recovery')
    try {
      const wrap = wrapIdentityKey(session.keyPair.privateKey, recovery.bytes, { userId: session.userId, kid: session.kid, kind: 'recovery' })
      await putBackup({ kind: 'recovery', ...wrap, proof: await proveKey(session.keyPair), expectedRevision: revisionOf('recovery') })
      toast('Your new recovery key is saved. The old one no longer works.')
      setRecovery(null)
      setSaved(false)
    } catch (e) {
      toast(errorMessage(e, 'The new recovery key couldn’t be saved.'))
    }
    setBusy(null)
  }

  /** One action changes the sign-in password and re-wraps the key backup (client-api.md, Changing the password). */
  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    const email = auth?.user.email
    if (!email) return
    setBusy('password')
    try {
      const currentAuthPassword = await derivedAuthPassword(current, email)
      const newAuthPassword = await derivedAuthPassword(next, email)
      const params = newPasswordParams()
      const wrap = wrapIdentityKey(session.keyPair.privateKey, passwordKey(next, params), { userId: session.userId, kid: session.kid, kind: 'password' })
      await changePasswordAction({
        currentAuthPassword,
        newAuthPassword,
        newWrap: { ...wrap, params },
        proof: await proveKey(session.keyPair),
        expectedRevision: revisionOf('password'),
      })
      toast('Password changed.')
      setCurrent('')
      setNext('')
    } catch (err) {
      // The backend's sentence says exactly what state things are in; show it as it is.
      toast(errorMessage(err, 'Your password couldn’t be changed.'))
    }
    setBusy(null)
  }

  return (
    <>
      <Heading
        title="Keys and devices"
        lead="Your messages are sealed to your key. The server keeps it only wrapped, by your password and your recovery key, and can’t open it."
      />
      <Setting title="Your key" about={`Key ID ${session.kid}. Unlocked on this device.`}>
        <span />
      </Setting>
      <Setting
        title="Recovery key"
        about="The way back in if you forget your password. Making a new one replaces the old."
        column
      >
        {recovery ? (
          <div className="mt-3">
            <div className="mb-2 rounded-md bg-surface-2 p-3 text-center font-mono text-base tracking-wide break-all shadow-[inset_0_0_0_1px_var(--border)]">
              {recovery.text}
            </div>
            <label className="mb-3 flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--accent)]"
                checked={saved}
                onChange={(e) => setSaved(e.target.checked)}
              />
              I’ve saved this recovery key somewhere safe.
            </label>
            <div className="flex gap-2">
              <Button variant="primary" disabled={!saved} loading={busy === 'recovery'} onClick={saveRecovery}>
                Use this recovery key
              </Button>
              <Button variant="ghost" onClick={() => setRecovery(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="mt-3"
            onClick={() => {
              setRecovery(generateRecoveryKey())
              setSaved(false)
            }}
          >
            Make a new recovery key
          </Button>
        )}
      </Setting>
      <Setting
        title="Password"
        about="Changes how you sign in and re-wraps your key backup with the new password."
        column
      >
        <form className="mt-3 grid max-w-[360px] gap-2" onSubmit={changePassword}>
          <Input
            type="password"
            autoComplete="current-password"
            placeholder="Current password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            aria-label="Current password"
          />
          <Input
            type="password"
            autoComplete="new-password"
            placeholder="New password, at least 12 characters"
            minLength={12}
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-label="New password"
          />
          <Button type="submit" className="justify-self-start" loading={busy === 'password'}>
            {busy === 'password' ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </Setting>
      <Setting
        title="Passkeys"
        about="Sign in without a password on this device. Unlocking your key with a passkey comes later."
      >
        <Button
          loading={busy === 'passkey'}
          onClick={async () => {
            setBusy('passkey')
            const result = await authClient.passkey.addPasskey()
            setBusy(null)
            if (result?.error) toast(errorMessage(result.error, 'That passkey couldn’t be added.'))
            else toast('Passkey added.')
          }}
        >
          Add a passkey
        </Button>
      </Setting>
      <p className="mt-2 text-sm text-subtle-foreground">
        Public key: <span className="font-mono">{toBase64Url(session.keyPair.publicKey).slice(0, 16)}…</span>
      </p>
    </>
  )
}
