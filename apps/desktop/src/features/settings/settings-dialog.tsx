import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import {
  decodeRecoveryKey,
  generateRecoveryKey,
  newPasswordParams,
  passkeyPrfSalt,
  passwordKey,
  ready,
  SealError,
  toBase64Url,
  unwrapIdentityKey,
  wrapIdentityKey,
  type RecoveryKey,
} from '@trioditis/crypto'
import { Badge } from '@trioditis/ui/badge'
import { Button } from '@trioditis/ui/button'
import { Checkbox } from '@trioditis/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useAction, useMutation } from 'convex/react'
import {
  Check,
  Copy,
  Eye,
  KeyRound,
  Plug,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import {
  networkName,
  useAccounts,
  useNetworkHealth,
  useNetworks,
  useServerInfo,
  useSidebarLayout,
} from '~/data/chats.ts'
import { authClient, derivedAuthPassword } from '~/lib/auth-client.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import {
  addPasskey,
  evaluatePasskeys,
  NoPrf,
  PasskeyCancelled,
  passkeyBackup,
  type PasskeyBackup,
  type PrfResult,
} from '~/lib/passkeys.ts'
import { setPref, usePrefs } from '~/lib/prefs.ts'
import { proveKey } from '~/lib/proof.ts'
import { useSession } from '~/lib/session.tsx'
import { Heading, Setting } from './layout.tsx'
import { LoginStepper } from './login-stepper.tsx'
import { Updates } from './updates.tsx'

// Two sets of settings, each its own panel: everyone's own (Settings), and the server's, for
// admins only (Admin settings).
export const SETTINGS_SECTIONS = [
  { id: 'appearance', name: 'Appearance', icon: <Eye /> },
  { id: 'accounts', name: 'Accounts', icon: <Plug /> },
  { id: 'keys', name: 'Keys and devices', icon: <KeyRound /> },
  { id: 'members', name: 'Members', icon: <Users />, admin: true },
  { id: 'updates', name: 'Updates', icon: <RefreshCw />, admin: true },
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']
const isAdminSection = (s: (typeof SETTINGS_SECTIONS)[number]) => 'admin' in s

/** The settings panel. The gear and the account menu open it; its section is in the URL. */
export function SettingsDialog({
  section,
  onSectionChange,
}: {
  section: SettingsSection | undefined
  onSectionChange: (s: SettingsSection | undefined) => void
}) {
  const session = useSession()
  const isAdmin = session.role === 'admin'
  const asked = SETTINGS_SECTIONS.find((s) => s.id === section)
  // A member who opens an admin section (an old link, say) gets their own settings instead.
  const admin = isAdmin && !!asked && isAdminSection(asked)
  const sections = SETTINGS_SECTIONS.filter((s) => isAdminSection(s) === admin)
  const current = sections.find((s) => s.id === section) ?? sections[0]!
  const other = SETTINGS_SECTIONS.find((s) => isAdminSection(s) !== admin)!
  return (
    <Dialog open={!!section} onOpenChange={(open) => !open && onSectionChange(undefined)}>
      <DialogContent className="flex h-[620px] w-[min(900px,calc(100vw-32px))]" aria-describedby={undefined}>
        <nav
          className="flex w-[220px] shrink-0 flex-col gap-0.5 border-r border-border bg-rail px-2.5 py-[18px]"
          aria-label="Settings sections"
        >
          <DialogTitle className="mx-2 mb-3.5 text-md">{admin ? 'Admin settings' : 'Settings'}</DialogTitle>
          {sections.map((s) => (
            <Button
              variant="bare"
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
            </Button>
          ))}
          {isAdmin ? (
            <Button
              variant="bare"
              type="button"
              onClick={() => onSectionChange(other.id)}
              className="mt-auto flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-left text-sm font-medium text-muted-foreground hover:bg-rail-hover hover:text-foreground [&_svg]:size-4"
            >
              {admin ? <SettingsIcon /> : <ShieldCheck />}
              {admin ? 'Your settings' : 'Admin settings'}
            </Button>
          ) : null}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-[22px] pb-7">
          {current.id === 'appearance' ? (
            <Appearance />
          ) : current.id === 'accounts' ? (
            <Accounts />
          ) : current.id === 'members' ? (
            <Members />
          ) : current.id === 'updates' ? (
            <Updates />
          ) : (
            <Keys />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
            <Button
              variant="bare"
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
            </Button>
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

// Why a disconnect didn't finish (`logoutError`): no bridge host took it within 10 minutes
// (`expired`), or one took it but never confirmed (`timeout`). Either way it may still be connected.
const LOGOUT_ERROR: Record<string, string> = {
  expired: 'The server’s bridge didn’t pick up the disconnect, so it’s still connected. Try again.',
  timeout: 'The server’s bridge never confirmed the disconnect, so it may still be connected. Try again.',
}

function Accounts() {
  const networks = useNetworks()
  const accounts = useAccounts()
  const health = useNetworkHealth()
  const server = useServerInfo()
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
                      ? (LOGOUT_ERROR[a.logoutError] ?? 'It couldn’t be disconnected. Try again.')
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
      {server?.demo ? <DemoSeed /> : null}
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
            <Button
              variant="bare"
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
            </Button>
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
 * A demo server can fill an account with made-up chats on a fake network, to try the app without
 * connecting a real one. Shown only where server.info says it's a demo.
 */
function DemoSeed() {
  const session = useSession()
  const seed = useAction(api.demo.seedForMe)
  const [busy, setBusy] = useState(false)
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg bg-surface-2 p-3 text-sm shadow-[inset_0_0_0_1px_var(--border)]">
      <span className="flex-1 text-muted-foreground">
        This is a demo server. You can fill your account with made-up chats.
      </span>
      <Button
        size="sm"
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
        Load demo chats
      </Button>
    </div>
  )
}

function Members() {
  const session = useSession()
  const server = useServerInfo()
  const invite = useMutation(api.members.invite)
  const revoke = useMutation(api.members.revokeInvitation)
  const { data: invitations } = useQuery(convexQuery(api.members.invitations, {}))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [link, setLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  // A server that takes no invitations (a demo) has nothing to invite with or list.
  const closed = server?.invitations === false

  return (
    <>
      <Heading
        title="Members"
        lead={
          closed
            ? 'Who can use this server.'
            : 'Who can use this server. Everyone signs up from an invitation link you share; they connect their own networks.'
        }
      />
      {server && closed ? (
        <p className="border-t border-border pt-4 text-sm text-muted-foreground">
          {server.demo
            ? 'This is a demo server, so it doesn’t take invitations.'
            : 'This server doesn’t take invitations.'}
        </p>
      ) : server ? (
        <form
          className="flex items-end gap-2 border-t border-border pt-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              const { token } = await invite({ email, role, sessionId: session.sessionId })
              // The token goes in the fragment, which never reaches a server or a proxy's logs.
              const query = new URLSearchParams({ email: email.trim().toLowerCase() })
              setLink(`${window.location.origin}/invite?${query}#token=${encodeURIComponent(token)}`)
              setCopied(false)
              setEmail('')
            } catch (err) {
              if (sessionChanged(err)) return window.location.reload()
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
      ) : null}
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
      {!closed || invitations?.length ? (
        <h3 className="mt-6 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
          Invitations
        </h3>
      ) : null}
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
      {!closed && invitations?.length === 0 ? (
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
  const [busy, setBusy] = useState<'recovery' | 'password' | null>(null)
  // Replacing a backup names the revision it replaces, so two devices can't overwrite each other.
  const revisionOf = (kind: 'password' | 'recovery') => identity?.backups.find((b) => b.kind === kind)?.revision ?? 0

  async function saveRecovery() {
    if (!recovery) return
    setBusy('recovery')
    try {
      const context = { userId: session.userId, kid: session.kid, kind: 'recovery' } as const
      const wrap = wrapIdentityKey(session.keyPair.privateKey, recovery.bytes, context)
      // Open it again from the text the person saved, as makeKeySetup does: the server can't
      // check a wrap, and one that doesn't open would leave them without a recovery key.
      unwrapIdentityKey(wrap, decodeRecoveryKey(recovery.text), context, session.keyPair.publicKey)
      await putBackup({
        kind: 'recovery',
        ...wrap,
        proof: await proveKey(session.keyPair, session.sessionId),
        expectedRevision: revisionOf('recovery'),
        sessionId: session.sessionId,
      })
      toast('Your new recovery key is saved. The old one no longer works.')
      setRecovery(null)
      setSaved(false)
    } catch (e) {
      // This page's session isn't the browser's any more: start again as whoever's signed in.
      if (sessionChanged(e)) return window.location.reload()
      toast(
        e instanceof SealError
          ? 'The new recovery key didn’t check out on this device, so nothing changed. Try again.'
          : errorMessage(e, 'The new recovery key couldn’t be saved.'),
      )
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
      // A fresh salt, and work factors never below the backup being replaced: the server refuses
      // weaker ones, and an account may have been set up with stronger.
      const fresh = newPasswordParams()
      const old = identity?.backups.find((b) => b.kind === 'password')?.params
      const params = {
        ...fresh,
        opslimit: Math.max(fresh.opslimit, old?.opslimit ?? 0),
        memlimit: Math.max(fresh.memlimit, old?.memlimit ?? 0),
      }
      const context = { userId: session.userId, kid: session.kid, kind: 'password' } as const
      const wrappingKey = passwordKey(next, params)
      const wrap = wrapIdentityKey(session.keyPair.privateKey, wrappingKey, context)
      // Opened again, as makeKeyBackup does: it throws a SealError unless it gives back this key.
      unwrapIdentityKey(wrap, wrappingKey, context, session.keyPair.publicKey)
      const newWrap = { ...wrap, params }
      // It returns the backup's new revision; keys.identity brings it here as well.
      await changePasswordAction({
        currentAuthPassword,
        newAuthPassword,
        newWrap,
        proof: await proveKey(session.keyPair, session.sessionId),
        expectedRevision: revisionOf('password'),
        sessionId: session.sessionId,
      })
      toast('Password changed.')
      setCurrent('')
      setNext('')
    } catch (err) {
      if (sessionChanged(err)) return window.location.reload()
      // The backend's sentence says exactly what state things are in (another device changed
      // it first, or there's no password to change); show it as it is.
      toast(
        err instanceof SealError
          ? 'Your key’s new backup didn’t check out on this device, so nothing changed. Try again.'
          : errorMessage(err, 'Your password couldn’t be changed.'),
      )
    }
    setBusy(null)
  }

  return (
    <>
      <Heading
        title="Keys and devices"
        lead="Your messages are sealed to your key. The server keeps it only wrapped, by your password, your recovery key and any passkey that unlocks it, and can’t open it."
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
              <Checkbox checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
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
      <Passkeys backups={identity?.backups} />
      <p className="mt-2 text-sm text-subtle-foreground">
        Public key: <span className="font-mono">{toBase64Url(session.keyPair.publicKey).slice(0, 16)}…</span>
      </p>
    </>
  )
}

/**
 * The person's passkeys: each signs in, and one with a passkey backup also unlocks the key on a
 * new device (lib/passkeys.ts). A backup is made from the passkey's PRF output, which the
 * authenticator gives when the passkey is added, or else the next time it's used.
 */
function Passkeys({ backups }: { backups: PasskeyBackup[] | undefined }) {
  const session = useSession()
  const putBackup = useMutation(api.keys.putBackup)
  const removePasskey = useMutation(api.keys.removePasskey)
  // Read for the page's own session, so another tab's sign-in never shows its passkeys here.
  const passkeys = useQuery(convexQuery(api.keys.passkeys, { sessionId: session.sessionId }))
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  // This key's passkey backups, by credential. One for an older key no longer opens anything.
  const backupOf = new Map(
    (backups ?? [])
      .filter((b) => b.kind === 'passkey' && b.kid === session.kid && b.credentialId)
      .map((b) => [b.credentialId!, b]),
  )
  const registered = new Set((passkeys.data ?? []).map((p) => p.credentialId))
  // A backup whose passkey no longer signs in (removed elsewhere) still opens the key with it.
  const unlockOnly = [...backupOf.keys()].filter((id) => passkeys.data && !registered.has(id))

  /** Wraps the key with a passkey's PRF output and stores it as that passkey's backup. */
  async function saveBackup(prf: PrfResult) {
    const backup = await passkeyBackup(session.userId, session.kid, session.keyPair, prf)
    await putBackup({
      ...backup,
      proof: await proveKey(session.keyPair, session.sessionId),
      // Replacing names the revision it replaces, 0 for a new one (client-api.md, Keys).
      expectedRevision: backupOf.get(prf.credentialId)?.revision ?? 0,
      sessionId: session.sessionId,
    })
  }

  /** What went wrong, in a toast; a page whose session changed starts again instead. */
  function report(e: unknown, fallback: string) {
    if (sessionChanged(e)) return window.location.reload()
    if (e instanceof PasskeyCancelled) return toast('The passkey prompt was closed. Nothing changed.')
    toast(
      e instanceof NoPrf
        ? `${e.message} It still signs you in.`
        : e instanceof SealError
          ? 'The passkey’s backup didn’t check out on this device, so it wasn’t saved. Try again.'
          : errorMessage(e, fallback),
    )
  }

  async function add() {
    setBusy('add')
    let added: Awaited<ReturnType<typeof addPasskey>>
    try {
      added = await addPasskey(session.sessionId)
    } catch (e) {
      report(e, 'The passkey couldn’t be added.')
      return setBusy(null)
    }
    if (!added.prf) {
      toast('Passkey added. It signs you in. To let it unlock your key too, choose “Use to unlock”.')
      return setBusy(null)
    }
    try {
      await saveBackup({ credentialId: added.credentialId, output: added.prf })
      toast('Passkey added. It signs you in and unlocks your key on a new device.')
    } catch (e) {
      report(
        e,
        'The passkey was added and signs you in, but it couldn’t be set to unlock your key. Try “Use to unlock”.',
      )
    }
    setBusy(null)
  }

  /** Asks a passkey for its PRF output now, and makes its backup from it. */
  async function useToUnlock(credentialId: string) {
    setBusy(credentialId)
    try {
      await ready()
      const prf = await evaluatePasskeys([{ credentialId, prfSalt: toBase64Url(passkeyPrfSalt()) }])
      if (prf.credentialId !== credentialId) throw new Error('A different passkey answered. Try again.')
      await saveBackup(prf)
      toast('This passkey now unlocks your key on a new device.')
    } catch (e) {
      report(e, 'The passkey couldn’t be set to unlock your key.')
    }
    setBusy(null)
  }

  /** Removes the passkey and its backup, together, in one step on the server. */
  async function remove(credentialId: string) {
    setConfirming(null)
    setBusy(credentialId)
    try {
      await removePasskey({
        credentialId,
        proof: await proveKey(session.keyPair, session.sessionId),
        sessionId: session.sessionId,
      })
      toast('Passkey removed.')
    } catch (e) {
      report(e, 'The passkey couldn’t be removed.')
    }
    setBusy(null)
  }

  const row = (credentialId: string, title: string, detail: string, registeredHere: boolean) => {
    const unlocks = backupOf.has(credentialId)
    return (
      <div key={credentialId} className="flex items-center gap-3 border-t border-border py-2.5">
        <KeyRound className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate font-semibold">
            {title}
            {unlocks ? <Badge variant="tag">Unlocks your key</Badge> : null}
          </div>
          <div className="text-sm text-muted-foreground">{detail}</div>
        </div>
        {confirming === credentialId ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Keep
            </Button>
            <Button size="sm" onClick={() => void remove(credentialId)}>
              Remove it
            </Button>
          </>
        ) : (
          <>
            {!unlocks && registeredHere ? (
              <Button
                size="sm"
                loading={busy === credentialId}
                disabled={busy !== null}
                onClick={() => void useToUnlock(credentialId)}
              >
                Use to unlock
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(credentialId)}>
              Remove
            </Button>
          </>
        )}
      </div>
    )
  }

  return (
    <Setting
      title="Passkeys"
      about="Sign in without a password. A passkey that unlocks your key also opens your messages on a new device."
      column
    >
      <div className="mt-3">
        {(passkeys.data ?? []).map((p) =>
          row(
            p.credentialId,
            p.name || 'Passkey',
            `${p.createdAt ? `Added ${new Date(p.createdAt).toLocaleDateString()}` : 'Added'}${p.backedUp ? ' · Synced' : ''}`,
            true,
          ),
        )}
        {unlockOnly.map((id) => row(id, 'Passkey', 'Unlocks your key, but no longer signs you in.', false))}
        {passkeys.isError ? (
          <p className="border-t border-border py-2.5 text-sm text-muted-foreground">
            Your passkeys couldn’t be listed. Reload the page to try again.
          </p>
        ) : passkeys.data?.length === 0 && unlockOnly.length === 0 ? (
          <p className="border-t border-border py-2.5 text-sm text-muted-foreground">No passkeys yet.</p>
        ) : null}
        <Button className="mt-3" loading={busy === 'add'} disabled={busy !== null} onClick={() => void add()}>
          Add a passkey
        </Button>
      </div>
    </Setting>
  )
}
