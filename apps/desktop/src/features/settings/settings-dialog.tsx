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
import { Button } from '@trioditis/ui/button'
import { Checkbox } from '@trioditis/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { Switch } from '@trioditis/ui/switch'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useAction, useMutation } from 'convex/react'
import {
  Bell,
  Check,
  Copy,
  Eye,
  KeyRound,
  Network as NetworkIcon,
  Plug,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { useSidebarLayout } from '~/data/chats.ts'
import { canNotify, notificationsAvailable } from '~/features/shell/notifications.ts'
import { authClient, derivedAuthPassword } from '~/lib/auth-client.ts'
import { passkeysUnavailable } from '~/lib/desktop.ts'
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
import { Group, Heading, Loading, Setting } from './layout.tsx'
import { Accounts } from './accounts-section.tsx'
import { Networks } from './networks.tsx'
import { Updates } from './updates.tsx'

/** Puts focus back on a control once it's rendered again: an opener a form or reveal replaced. */
const refocus = (ref: RefObject<HTMLElement | null>) => requestAnimationFrame(() => ref.current?.focus())

// Two sets of settings, each its own panel: everyone's own (Settings), and the server's, for
// admins only (Admin settings).
export const SETTINGS_SECTIONS = [
  { id: 'appearance', name: 'Appearance', icon: <Eye /> },
  { id: 'notifications', name: 'Notifications', icon: <Bell /> },
  { id: 'accounts', name: 'Accounts', icon: <Plug /> },
  { id: 'keys', name: 'Keys and devices', icon: <KeyRound /> },
  { id: 'networks', name: 'Networks', icon: <NetworkIcon />, admin: true },
  { id: 'members', name: 'Members', icon: <Users />, admin: true },
  { id: 'updates', name: 'Updates', icon: <RefreshCw />, admin: true },
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['id']
const isAdminSection = (s: (typeof SETTINGS_SECTIONS)[number]) => 'admin' in s

/** The settings panel. The gear and the account menu open it; its section is in the URL. */
export function SettingsDialog({
  section,
  connect,
  onSectionChange,
}: {
  section: SettingsSection | undefined
  /** Opened to connect a network: Accounts shows the networks at once. */
  connect: boolean
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
              // Choosing the open section again changes nothing, so a list it opened stays as it is.
              onClick={() => s.id !== current.id && onSectionChange(s.id)}
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
        <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-14 pb-7">
          {current.id === 'appearance' ? (
            <Appearance />
          ) : current.id === 'notifications' ? (
            <Notifications />
          ) : current.id === 'accounts' ? (
            <Accounts connect={connect} />
          ) : current.id === 'networks' ? (
            <Networks />
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
    // The drawings show what each layout does; `about` says it for screen readers, which skip them.
    {
      id: 'simple' as const,
      name: 'Simple',
      about: 'Every chat in one list, newest first.',
      drawing: <MiniSimple />,
    },
    {
      id: 'focused' as const,
      name: 'Focused',
      about: 'Unread on top; read, snoozed, scheduled and archived chats fold away.',
      drawing: <MiniFocused />,
    },
  ]
  return (
    <>
      <Heading title="Appearance" />
      <Group>
        <Setting title="Theme">
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
      </Group>
      <Group title="Chat list">
        <Setting
          title="Layout"
          below={
            <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Sidebar layout">
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
                  <span className={cn('font-bold', layout === o.id && 'text-primary-ink')}>{o.name}</span>
                  <span className="sr-only">{o.about}</span>
                </Button>
              ))}
            </div>
          }
        />
        <Setting title="Message previews">
          <Switch
            checked={prefs.previews}
            onCheckedChange={(v) => setPref('previews', v)}
            aria-label="Message previews"
          />
        </Setting>
        <Setting title="Network badges">
          <Switch
            checked={prefs.networkBadges}
            onCheckedChange={(v) => setPref('networkBadges', v)}
            aria-label="Network badges"
          />
        </Setting>
      </Group>
    </>
  )
}

function Notifications() {
  const prefs = usePrefs()
  const supported = notificationsAvailable()
  // The browser's answer, asked again only when the person turns notifications on.
  const [allowed, setAllowed] = useState(canNotify)
  async function turn(on: boolean) {
    if (!on) return setPref('notifications', false)
    const granted = allowed || (await Notification.requestPermission()) === 'granted'
    setAllowed(granted)
    if (granted) setPref('notifications', true)
    else toast('Notifications are blocked for this site. Allow them in your browser’s site settings, then try again.')
  }
  return (
    <>
      <Heading title="Notifications" />
      {/* Kept in view: a notification puts the sender and the message's text in the system's own history,
          outside what Trioditis seals. */}
      <Group>
        <Setting
          title="Desktop notifications"
          about={
            supported
              ? 'Shows the sender and message text, which your system may keep.'
              : 'This browser can’t show notifications.'
          }
        >
          <Switch
            checked={prefs.notifications && allowed}
            disabled={!supported}
            onCheckedChange={(v) => void turn(v)}
            aria-label="Desktop notifications"
          />
        </Setting>
      </Group>
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

// Invitation links made on this page, newest first. The server gives each one only once, so they
// outlive Members (another section, the dialog closing, an answer that comes after either) until
// the page reloads. They're kept in memory only.
type MadeLink = { invitationId: string; email: string; link: string }
let madeLinks: readonly MadeLink[] = []
const madeLinkListeners = new Set<() => void>()
function addMadeLink(made: MadeLink) {
  madeLinks = [made, ...madeLinks]
  for (const listener of madeLinkListeners) listener()
}
function dropMadeLink(invitationId: string) {
  madeLinks = madeLinks.filter((made) => made.invitationId !== invitationId)
  for (const listener of madeLinkListeners) listener()
}
function subscribeMadeLinks(listener: () => void) {
  madeLinkListeners.add(listener)
  return () => void madeLinkListeners.delete(listener)
}

function Members() {
  const session = useSession()
  // The same query as useServerInfo, read whole here to tell a failed load from a slow one.
  const { data: server, isError: serverFailed } = useQuery(convexQuery(api.server.info, {}))
  const invite = useMutation(api.members.invite)
  const revoke = useMutation(api.members.revokeInvitation)
  const { data: invitations } = useQuery(convexQuery(api.members.invitations, {}))
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const links = useSyncExternalStore(subscribeMadeLinks, () => madeLinks)
  // The link just made here, which takes focus; and the links copied so far.
  const [justMade, setJustMade] = useState<string | null>(null)
  const [copied, setCopied] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // The form opens from Invite and closes once the link is made, which then shows in its place.
  const [inviting, setInviting] = useState(false)
  const inviteOpener = useRef<HTMLButtonElement>(null)
  // A server that takes no invitations (a demo) has nothing to invite with or list.
  const closed = server?.invitations === false
  // A link is shown while its invitation is still waiting: once it's joined, revoked (which
  // deletes it) or expired, the link no longer works. The list holds only the newest 100, so a link
  // whose invitation isn't in a full list may still work, and stays. Before the list loads, every
  // link shows.
  const shownLinks = invitations
    ? links.filter((made) => {
        const inv = invitations.find((i) => i._id === made.invitationId)
        return inv ? !inv.acceptedAt && inv.expiresAt >= Date.now() : invitations.length >= 100
      })
    : links

  return (
    <>
      <Heading title="Members" />
      {!server ? (
        <Loading failed={serverFailed} />
      ) : (
        <Group
          title="Invitations"
          action={
            !closed && !inviting ? (
              <Button ref={inviteOpener} size="sm" disabled={busy} onClick={() => setInviting(true)}>
                <Plus className="size-4" /> Invite
              </Button>
            ) : null
          }
        >
          {closed ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {server.demo
                ? 'This is a demo server, so it doesn’t take invitations.'
                : 'This server doesn’t take invitations.'}
            </p>
          ) : null}
          {inviting ? (
            <form
              className="grid gap-2 px-4 py-3"
              onSubmit={async (e) => {
                e.preventDefault()
                setBusy(true)
                try {
                  const { invitationId, token } = await invite({ email, role, sessionId: session.sessionId })
                  // The token goes in the fragment, which never reaches a server or a proxy's logs.
                  const invited = email.trim().toLowerCase()
                  const query = new URLSearchParams({ email: invited })
                  const link = `${window.location.origin}/invite?${query}#token=${encodeURIComponent(token)}`
                  addMadeLink({ invitationId, email: invited, link })
                  setJustMade(link)
                  setEmail('')
                  setInviting(false)
                } catch (err) {
                  if (sessionChanged(err)) return window.location.reload()
                  toast(errorMessage(err, 'That invitation couldn’t be made.'))
                }
                setBusy(false)
              }}
            >
              <label>
                <span className="mb-1.5 block text-sm font-semibold">Email</span>
                <Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  value={role}
                  onValueChange={(v) => setRole(v as 'member' | 'admin')}
                  className="w-[160px]"
                  aria-label="Role"
                >
                  <SegmentedItem value="member">Member</SegmentedItem>
                  <SegmentedItem value="admin">Admin</SegmentedItem>
                </Segmented>
                <Button type="submit" variant="primary" loading={busy}>
                  Invite
                </Button>
                {/* Not while the invitation is being made: it would be made anyway. */}
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setInviting(false)
                    refocus(inviteOpener)
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null}
          {shownLinks.length ? (
            <div className="px-4 py-3">
              <p className="mb-2 text-sm text-muted-foreground">
                Send them this link. It works once, for a week, and won’t be shown again.
              </p>
              <div className="grid gap-3">
                {shownLinks.map(({ email: invited, link }) => (
                  <div key={link}>
                    {shownLinks.length > 1 ? <div className="mb-1 text-sm font-semibold">{invited}</div> : null}
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        // A new link is where the admin goes next: to copy it.
                        autoFocus={link === justMade}
                        value={link}
                        className="font-mono text-sm"
                        onFocus={(e) => e.target.select()}
                        aria-label={`Invitation link for ${invited}`}
                      />
                      <Button
                        onClick={() =>
                          navigator.clipboard.writeText(link).then(
                            () => setCopied((done) => new Set(done).add(link)),
                            () => toast('Copying didn’t work here. Select the link and copy it.'),
                          )
                        }
                      >
                        {copied.has(link) ? <Check className="size-4" /> : <Copy className="size-4" />}{' '}
                        {copied.has(link) ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {(invitations ?? []).map((inv) => (
            <div key={inv._id} className="flex min-h-[60px] items-center gap-3 px-4 py-3">
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
                    void revoke({ invitationId: inv._id as Id<'invitations'> }).then(
                      // Its link goes at once: a list holding its full 100 can't show the invitation is gone.
                      () => dropMadeLink(inv._id),
                      (e: unknown) => toast(errorMessage(e, 'That invitation couldn’t be revoked.')),
                    )
                  }
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
        </Group>
      )}
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
  // The key's details and the password form stay closed until asked for.
  const [showKey, setShowKey] = useState(false)
  const [changing, setChanging] = useState(false)
  const recoveryOpener = useRef<HTMLButtonElement>(null)
  const passwordOpener = useRef<HTMLButtonElement>(null)
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
      refocus(recoveryOpener)
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
      setChanging(false)
      refocus(passwordOpener)
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
      <Heading title="Keys and devices" />
      <Group title="Encryption">
        <Setting
          title="Your key"
          below={
            showKey ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Key ID</dt>
                <dd className="font-mono break-all">{session.kid}</dd>
                <dt className="text-muted-foreground">Public key</dt>
                <dd className="font-mono break-all">{toBase64Url(session.keyPair.publicKey)}</dd>
              </dl>
            ) : null
          }
        >
          <Button size="sm" aria-expanded={showKey} onClick={() => setShowKey(!showKey)}>
            {showKey ? 'Hide' : 'Show'}
          </Button>
        </Setting>
        <Setting
          title="Recovery key"
          about="A new one replaces the old."
          below={
            recovery ? (
              <>
                <div className="mb-2 rounded-md bg-surface-2 p-3 text-center font-mono text-base tracking-wide break-all">
                  {recovery.text}
                </div>
                <label className="mb-3 flex items-center gap-2.5 text-sm">
                  {/* Focus lands here when the key opens: saving it is the next step. */}
                  <Checkbox autoFocus checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
                  I’ve saved this recovery key somewhere safe.
                </label>
                <div className="flex gap-2">
                  <Button variant="primary" disabled={!saved} loading={busy === 'recovery'} onClick={saveRecovery}>
                    Use this recovery key
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setRecovery(null)
                      refocus(recoveryOpener)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : null
          }
        >
          {recovery ? null : (
            <Button
              ref={recoveryOpener}
              size="sm"
              onClick={() => {
                setRecovery(generateRecoveryKey())
                setSaved(false)
              }}
            >
              Make a new one
            </Button>
          )}
        </Setting>
      </Group>
      <Group title="Sign-in">
        <Setting
          title="Password"
          below={
            changing ? (
              <form className="grid max-w-[360px] gap-2" onSubmit={changePassword}>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Current password"
                  required
                  autoFocus
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
                <div className="flex gap-2">
                  <Button type="submit" variant="primary" loading={busy === 'password'}>
                    {busy === 'password' ? 'Changing…' : 'Change password'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy === 'password'}
                    onClick={() => {
                      setChanging(false)
                      setCurrent('')
                      setNext('')
                      refocus(passwordOpener)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : null
          }
        >
          {changing ? null : (
            <Button ref={passwordOpener} size="sm" onClick={() => setChanging(true)}>
              Change
            </Button>
          )}
        </Setting>
        <Passkeys backups={identity?.backups} />
      </Group>
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
      <div key={credentialId} className="flex min-h-[60px] items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{title}</div>
          <div className="text-sm text-muted-foreground">
            {detail}
            {unlocks && registeredHere ? ' · Unlocks your key' : ''}
          </div>
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
                disabled={busy !== null || !!passkeysUnavailable}
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

  // Rows of the sign-in group: the passkeys heading row with Add, then one row per passkey.
  return (
    <>
      <Setting
        title="Passkeys"
        about={
          passkeys.isError || passkeysUnavailable ? (
            <>
              {passkeys.isError ? (
                <span className="block">Your passkeys couldn’t be listed. Reload the page to try again.</span>
              ) : null}
              {passkeysUnavailable ? (
                <span className="block">{passkeysUnavailable} Add them, and set them to unlock, in a browser.</span>
              ) : null}
            </>
          ) : undefined
        }
      >
        <Button
          size="sm"
          aria-label="Add a passkey"
          loading={busy === 'add'}
          disabled={busy !== null || !!passkeysUnavailable}
          onClick={() => void add()}
        >
          <Plus className="size-4" /> Add
        </Button>
      </Setting>
      {(passkeys.data ?? []).map((p) =>
        row(
          p.credentialId,
          p.name || 'Passkey',
          `${p.createdAt ? `Added ${new Date(p.createdAt).toLocaleDateString()}` : 'Added'}${p.backedUp ? ' · Synced' : ''}`,
          true,
        ),
      )}
      {unlockOnly.map((id) => row(id, 'Passkey', 'Unlocks your key, but no longer signs you in.', false))}
    </>
  )
}
