import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { toast } from '@trioditis/ui/toast'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { Check, Copy, Plus } from 'lucide-react'
import { useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'
import { Group, Heading, Loading } from './layout.tsx'
import { linksToShow, type MadeLink } from './member-links.ts'

/** How many rows each list loads at a time; More loads the next as many. */
const PAGE_SIZE = 50

/** Puts focus back on a control once it's rendered again: an opener a form replaced. */
const refocus = (ref: RefObject<HTMLElement | null>) => requestAnimationFrame(() => ref.current?.focus())

// Invitation links made on this page, newest first. The server gives each one only once, so they
// outlive Members (another section, the dialog closing, an answer that comes after either) until
// the page reloads. They're kept in memory only.
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

export function Members() {
  const { data: server, isError: serverFailed } = useQuery(convexQuery(api.server.info, {}))
  return (
    <>
      <Heading title="Members" />
      {!server ? (
        <Loading failed={serverFailed} />
      ) : (
        <>
          <People />
          <Cleanup />
          <Invitations closed={server.invitations === false} demo={server.demo} />
        </>
      )}
    </>
  )
}

type Person = {
  userId: string
  role: 'admin' | 'member'
  name: string | null
  email: string | null
  you: boolean
}

/** Everyone on the server. An admin can reset anyone else's password, or remove them. */
function People() {
  const people = usePaginatedQuery(api.members.list, {}, { initialNumItems: PAGE_SIZE })
  return (
    <Group title="People">
      {people.status === 'LoadingFirstPage' ? (
        <div className="px-4 py-3">
          <Loading />
        </div>
      ) : null}
      {people.results.map((person) => (
        <PersonRow key={person.userId} person={person} />
      ))}
      {people.status === 'CanLoadMore' ? <More onClick={() => people.loadMore(PAGE_SIZE)} /> : null}
    </Group>
  )
}

function PersonRow({ person }: { person: Person }) {
  const session = useSession()
  const remove = useMutation(api.members.removeMember)
  const issueReset = useMutation(api.members.issuePasswordReset)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<'remove' | 'reset' | null>(null)
  // A reset link the server gives only once, so it's shown here until the dialog closes.
  const [resetLink, setResetLink] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const label = person.email ?? person.name ?? 'this person'

  async function run(what: 'remove' | 'reset', call: () => Promise<void>, failure: string) {
    setBusy(what)
    try {
      await call()
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, failure))
    }
    setBusy(null)
  }

  return (
    <div className="px-4 py-3">
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-[1_1_10rem]">
          <div className="truncate font-semibold">
            {person.name ?? person.email ?? 'Unknown account'}
            {person.you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {person.role === 'admin' ? 'Admin' : 'Member'}
            {person.name && person.email ? ` · ${person.email}` : null}
          </div>
        </div>
        {person.you ? null : confirming ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              loading={busy === 'remove'}
              onClick={() =>
                void run(
                  'remove',
                  async () => {
                    await remove({ userId: person.userId, sessionId: session.sessionId })
                  },
                  'That person couldn’t be removed.',
                )
              }
            >
              Remove
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'reset'}
              disabled={busy !== null}
              aria-label={`Reset the password of ${label}`}
              onClick={() =>
                void run(
                  'reset',
                  async () => {
                    const { token } = await issueReset({ userId: person.userId, sessionId: session.sessionId })
                    // The token goes in the fragment, which never reaches a server or a proxy's logs.
                    setResetLink(`${window.location.origin}/reset#token=${encodeURIComponent(token)}`)
                    setCopied(false)
                  },
                  'A reset link couldn’t be made.',
                )
              }
            >
              Reset password
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              aria-label={`Remove ${label}`}
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          </div>
        )}
      </div>
      {confirming ? (
        <p className="mt-2 text-sm text-muted-foreground">
          They’re signed out everywhere, their agents and network accounts are disconnected, and their messages stay
          sealed where nobody can read them. You can invite them again.
        </p>
      ) : null}
      {resetLink ? (
        <div className="mt-3">
          <p className="mb-2 text-sm text-muted-foreground">
            Send them this link. It works once, for a day, with their recovery key, and won’t be shown again.
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              autoFocus
              value={resetLink}
              className="font-mono text-sm"
              onFocus={(e) => e.target.select()}
              aria-label={`Password reset link for ${label}`}
            />
            <Button
              onClick={() =>
                navigator.clipboard.writeText(resetLink).then(
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
    </div>
  )
}

/**
 * Removed people whose network accounts aren't confirmed logged out yet. A logout that only ran
 * out of time is queued again by itself; one a bridge host refused can be tried again here.
 */
function Cleanup() {
  const session = useSession()
  const cleanups = usePaginatedQuery(api.members.removedCleanup, {}, { initialNumItems: PAGE_SIZE })
  const left = cleanups.results.filter((row) => row.accounts > 0)
  const retry = useMutation(api.members.retryCleanup)
  const [busy, setBusy] = useState<string | null>(null)
  if (!left.length && cleanups.status !== 'CanLoadMore') return null
  return (
    <Group title="Disconnecting removed people">
      {left.map((row) => (
        <div key={row.userId} className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-[1_1_10rem]">
            <div className="truncate font-semibold">{row.email ?? 'Removed account'}</div>
            <div className="text-sm text-muted-foreground">
              {row.failed
                ? `${row.failed} of ${row.accounts} network ${row.accounts === 1 ? 'account' : 'accounts'} didn’t log out`
                : `Logging out ${row.accounts} network ${row.accounts === 1 ? 'account' : 'accounts'}…`}
            </div>
          </div>
          {row.failed ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === row.userId}
              onClick={async () => {
                setBusy(row.userId)
                try {
                  await retry({ userId: row.userId, sessionId: session.sessionId })
                } catch (e) {
                  if (sessionChanged(e)) return window.location.reload()
                  toast(errorMessage(e, 'That couldn’t be tried again.'))
                }
                setBusy(null)
              }}
            >
              Try again
            </Button>
          ) : null}
        </div>
      ))}
      {cleanups.status === 'CanLoadMore' ? <More onClick={() => cleanups.loadMore(PAGE_SIZE)} /> : null}
    </Group>
  )
}

function More({ onClick }: { onClick: () => void }) {
  return (
    <div className="px-4 py-2">
      <Button size="sm" variant="ghost" onClick={onClick}>
        Show more
      </Button>
    </div>
  )
}

function Invitations({ closed, demo }: { closed: boolean; demo: boolean }) {
  const session = useSession()
  const invite = useMutation(api.members.invite)
  const revoke = useMutation(api.members.revokeInvitation)
  const invitations = usePaginatedQuery(api.members.invitations, closed ? 'skip' : {}, {
    initialNumItems: PAGE_SIZE,
  })
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
  const loaded = invitations.status !== 'LoadingFirstPage'
  const shownLinks = linksToShow(links, loaded ? invitations.results : undefined, invitations.status === 'Exhausted')

  return (
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
          {demo ? 'This is a demo server, so it doesn’t take invitations.' : 'This server doesn’t take invitations.'}
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
      {invitations.results.map((inv) => (
        <div key={inv._id} className="flex min-h-[60px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <div className="min-w-0 flex-[1_1_10rem]">
            <div className="truncate font-semibold">{inv.email}</div>
            <div className="text-sm text-muted-foreground">
              {inv.role === 'admin' ? 'Admin' : 'Member'} · {inv.expiresAt < Date.now() ? 'Expired' : 'Waiting'}
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void revoke({ invitationId: inv._id as Id<'invitations'> }).then(
                // Its link goes at once, without waiting for the list to say the invitation is gone.
                () => dropMadeLink(inv._id),
                (e: unknown) => toast(errorMessage(e, 'That invitation couldn’t be revoked.')),
              )
            }
          >
            Revoke
          </Button>
        </div>
      ))}
      {invitations.status === 'CanLoadMore' ? <More onClick={() => invitations.loadMore(PAGE_SIZE)} /> : null}
    </Group>
  )
}
