import { api } from '@trioditis/backend/api'
import type { KeyPair, PasswordParams } from '@trioditis/crypto'
import {
  decodeRecoveryKey,
  fromBase64Url,
  generateKeyPair,
  keyId,
  makeKeySetup,
  passkeyPrfSalt,
  passwordKey,
  ready,
  SealError,
  toBase64Url,
  unwrapIdentityKey,
} from '@trioditis/crypto'
import { Button } from '@trioditis/ui/button'
import { Checkbox } from '@trioditis/ui/checkbox'
import { Input } from '@trioditis/ui/input'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { Navigate } from '@tanstack/react-router'
import { ConvexHttpClient } from 'convex/browser'
import { useConvexAuth, useMutation } from 'convex/react'
import { Check, Copy, KeyRound, ShieldCheck } from 'lucide-react'
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react'
import { authClient, convexTokenFor } from '~/lib/auth-client.ts'
import { config } from '~/lib/config.ts'
import { convex } from '~/lib/convex.ts'
import { canKeepKeys, KeepRefused, loadIdentity, onFence, saveToken, storeIdentity } from '~/lib/keys.ts'
import {
  currentSessionId,
  fenceSession,
  leaveForSignIn,
  noteOpenedSession,
  openedSession,
  rememberSession,
  SIGN_OUT_UNSTORED,
  signingOut,
  signOut,
} from '~/lib/sign-out.ts'
import { takePassword } from '~/lib/pending-password.ts'
import {
  evaluatePasskeys,
  NoPrf,
  openPasskeyBackup,
  PasskeyCancelled,
  takePrf,
  type PrfResult,
} from '~/lib/passkeys.ts'
import { proveKey } from '~/lib/proof.ts'
import { SessionContext, type Session } from '~/lib/session.tsx'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { AuthCard, Field, FormError } from './auth-card.tsx'

/**
 * Everything signed in passes through here: the account must be a member of this server, and
 * this device must hold the person's identity key, since nothing can be read without it.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const signedOut = useConfirmedSignedOut(!isLoading && !isAuthenticated)
  if (isAuthenticated) return <MemberGate>{children}</MemberGate>
  // A page that was signed in leaves as its session's end says (a sign-out of its own may be
  // finishing, or never heard back): see leaveForSignIn. One that never was just goes to sign in.
  if (signedOut && openedSession()) {
    void leaveForSignIn()
    return <Splash />
  }
  if (signedOut) return <Navigate to="/sign-in" />
  return <Splash />
}

/**
 * Right after signing in or up, Convex can report "not signed in" for a moment, and the
 * session the page cached before can still say so too. So before sending the person to sign
 * in, ask Better Auth afresh; only a fresh "no session" counts.
 */
function useConfirmedSignedOut(convexSaysSignedOut: boolean) {
  const [signedOut, setSignedOut] = useState(false)
  useEffect(() => {
    if (!convexSaysSignedOut) {
      setSignedOut(false)
      return
    }
    let cancelled = false
    void authClient.getSession().then(({ data }) => {
      if (!cancelled && !data) setSignedOut(true)
    })
    return () => {
      cancelled = true
    }
  }, [convexSaysSignedOut])
  return signedOut
}

function MemberGate({ children }: { children: ReactNode }) {
  // Who is signed in, in which session, and their membership, all from the one result, so
  // signing out always ends the session this page is for (members.me).
  const me = useQuery(convexQuery(api.members.me, {}))
  const sessionId = me.data?.sessionId
  // A page belongs to the session it opened with (lib/account-tabs.ts): if another turns up,
  // it starts again as that one. Its token is noted while this browser is in it, for signing
  // out of exactly it (lib/sign-out.ts).
  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (!sessionId) return
    if (opened.current && opened.current !== sessionId) return window.location.reload()
    opened.current = sessionId
    noteOpenedSession(sessionId)
    let stop = false
    const note = (tries: number): unknown =>
      rememberSession(sessionId).then((noted) => {
        if (noted === 'changed') window.location.reload()
        else if (noted === 'unknown' && tries > 0 && !stop) setTimeout(() => note(tries - 1), 3000)
      })
    void note(5)
    return () => {
      stop = true
    }
  }, [sessionId])
  if (opened.current && sessionId && opened.current !== sessionId) return <Splash />
  if (me.isPending) return <Splash />
  // The session Convex was given has ended. Loaded afresh, the page asks for a token again and
  // finds none, rather than going on with the one it holds until it expires.
  // A sign-out under way here goes on to the sign-in page itself, with what it must say.
  if (!me.data) {
    void leaveForSignIn(opened.current)
    return <Splash />
  }
  if (!me.data.member) {
    return (
      <AuthCard
        title="This account isn’t on this server"
        description="It may have been removed. Ask the server’s admin for an invitation."
      >
        <SignOutButton userId={me.data.userId} sessionId={me.data.sessionId} />
      </AuthCard>
    )
  }
  return (
    <KeyGate key={me.data.userId} userId={me.data.userId} sessionId={me.data.sessionId} role={me.data.member.role}>
      {children}
    </KeyGate>
  )
}

function KeyGate({
  userId,
  sessionId,
  role,
  children,
}: {
  userId: string
  sessionId: string
  role: 'admin' | 'member'
  children: ReactNode
}) {
  const remote = useQuery(convexQuery(api.keys.identity, {}))
  // The save token (lib/keys.ts): taken as the gate opens, before any setup or unlock, and again
  // whenever saves are fenced in any tab (a sign-out attempt, whichever way it went) or this tab
  // comes back into view. Work begun under an older token stays fenced; work begun after uses the
  // new one. If it can't be read, nothing is kept here: saving fails closed.
  const [token, setToken] = useState<number | 'failed' | null>(null)
  useEffect(() => {
    let current: number | 'failed' | null = null
    const take = () =>
      saveToken(userId).then(
        (next) => {
          if (next !== current) setToken((current = next))
        },
        () => setToken((current = 'failed')),
      )
    void take()
    const stopListening = onFence(userId, () => void take())
    const onVisible = () => document.visibilityState === 'visible' && void take()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopListening()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [userId])
  // This device's key, read afresh for each token, so after a fence anywhere the gate never goes on
  // with a key that may have been forgotten since; not kept once the gate is gone (gcTime 0).
  // While that read runs, "no key here" stays as it was, so an unlock or setup screen keeps what's
  // typed in it; a key read before, though, is never shown again.
  const local = useQuery({
    queryKey: ['identity', userId, token],
    queryFn: () => loadIdentity(userId),
    enabled: token !== null,
    staleTime: Infinity,
    gcTime: 0,
    placeholderData: (previous) => (previous === null ? null : undefined),
  })
  // While setup is saving, the server's state turns `ready` before this device has kept the key.
  // Holding the setup screen until it's done keeps its progress, errors and retry on screen.
  const [held, setHeld] = useState<SetupFor | null>(null)
  // The key setup just finished and kept here: it's ready, even before the live query says so
  // (it can lag, or still hold an error from during setup).
  const [setUpKid, setSetUpKid] = useState<string | null>(null)
  const [, recheck] = useReducer((n: number) => n + 1, 0)
  // Recovery checks settled on this page, even if clearing their note from storage failed.
  const acked = useRef(new Set<string>())

  // Signing out from setup or unlock is the gate's, shown ahead of everything else here, so
  // nothing (setup finishing, the app opening) takes its screen while it runs. It stops saves for
  // this session first, then waits a little for a backup call under way, then forgets this device's key if its backups are known to
  // exist, from setup's own answer or from the server for this key; unsure, it keeps it (it may
  // be the only copy). From then on no tab keeps a key for this session (lib/keys.ts).
  // If it fails, going back reloads the page, to start again from what's really there.
  const [leaving, setLeaving] = useState<'running' | 'failed' | null>(null)
  const leavingFailure = useRef('')
  const leavingRef = useRef(false)
  const backup = useRef<{
    call: Promise<unknown> | null
    /** The key setup saw keys.setup accept: its backups exist. */
    savedKid: string | null
    lost: boolean
    /** A recovery key shown here couldn't be kept track of across a reload. */
    untracked: boolean
  }>({ call: null, savedKid: null, lost: false, untracked: false })
  const remoteNow = useRef(remote.data)
  remoteNow.current = remote.data
  // The key the first attempt was for; a retry is for the same one (null: keep whatever's here).
  const leavingFor = useRef<string | null>(null)
  const signOutHere = (keyKid: string | null) => signingOut(leave(keyKid))
  // The key whose backups are known to exist now, if any: the account's ready key, whichever it
  // is (another device may have won setup, and another tab unlocked it here), or the one setup
  // here saw saved. Removing it touches only that key, and only if it's the one stored.
  const knownBackedUp = (keyKid: string | null) => {
    const server = remoteNow.current
    if (server?.state === 'ready' && server.kid) return server.kid
    return keyKid !== null && backup.current.savedKid === keyKid ? keyKid : null
  }
  const leave = async (keyKid: string | null) => {
    leavingRef.current = true
    leavingFor.current = keyKid
    setLeaving('running')
    // Saves for this session stop first, in every tab, before anything is waited on: if this page
    // goes away meanwhile (another tab's sign-in reloads it), no key lands after the sign-out began.
    // A key already known to be backed up goes in the same step, saved here just before or not.
    if (!(await fenceSession(userId, sessionId, knownBackedUp(keyKid)))) {
      leavingFailure.current = SIGN_OUT_UNSTORED
      setLeaving('failed')
      return
    }
    await settled(backup.current.call)
    const backedUp = knownBackedUp(keyKid)
    // Only that key is forgotten, and only if it's the one here (checked as it's removed); unsure,
    // none is, but saves still under way in any tab are stopped all the same.
    const failure = await signOut(userId, sessionId, {
      onlyKid: backedUp,
      backedUpKid: backedUp ? undefined : () => backedUpNow(sessionId),
    })
    if (failure === null) return
    leavingFailure.current = failure
    setLeaving('failed')
  }
  const isLeaving = () => leavingRef.current
  if (leaving) {
    return (
      <SignOutProgress
        state={leaving}
        failure={leavingFailure.current}
        onRetry={() => void signOutHere(leavingFor.current)}
      >
        {backup.current.lost ? <RecoveryLostNote /> : null}
        {backup.current.untracked && !backup.current.lost ? <RecoveryUntrackedNote /> : null}
      </SignOutProgress>
    )
  }

  const setupScreen = (setupFor: SetupFor) => (
    <KeySetup
      userId={userId}
      existing={setupFor.existing}
      has={setupFor.has}
      onSaving={() => setHeld(setupFor)}
      onLeave={() => setHeld(null)}
      sessionId={sessionId}
      onSignOut={(keyKid) => void signOutHere(keyKid)}
      isLeaving={isLeaving}
      onBackup={(call) => {
        backup.current.call = call.then((result) => {
          backup.current.savedKid = (result as { kid: string }).kid
        })
      }}
      onRecoveryUntracked={() => {
        backup.current.untracked = true
      }}
      token={token}
      onRecoveryLost={(lost) => {
        backup.current.lost = lost
      }}
      onDone={async (doneKid) => {
        // Read straight from the device: a failed refetch would still offer the data it had.
        // Until the key reads back, setup stays on screen, with Try again.
        const kept = await loadIdentity(userId)
        if (kept?.kid !== doneKid) throw new Error('the key couldn’t be read back from this device')
        await local.refetch()
        if (leavingRef.current) return
        setSetUpKid(doneKid)
        setHeld(null)
        void remote.refetch()
      }}
    />
  )
  if (held) return setupScreen(held)
  if (local.data && setUpKid && local.data.kid === setUpKid) {
    const session: Session = { userId, sessionId, role, kid: local.data.kid, keyPair: local.data.keyPair }
    return <SessionContext value={session}>{children}</SessionContext>
  }
  if (token === null || remote.isPending || local.isPending || !remote.data) return <Splash />
  const { state, publicKey, kid, backups } = remote.data
  const here = local.data && local.data.kid === kid ? local.data : null
  const setupFor: SetupFor | null =
    state === 'none'
      ? { has: { password: false, recovery: false } }
      : state === 'needsBackup' && here
        ? {
            existing: here.keyPair,
            has: {
              password: backups.some((b) => b.kind === 'password'),
              recovery: backups.some((b) => b.kind === 'recovery'),
            },
          }
        : null
  if (setupFor) {
    // Setting up a key keeps it on this device, which an insecure page can't do.
    if (!canKeepKeys()) return <InsecurePage userId={userId} sessionId={sessionId} />
    return setupScreen(setupFor)
  }
  if (state === 'needsBackup') {
    // The key exists but its backups aren't both there: only a device holding the key can make
    // them. This device may hold it even if reading it failed, so signing out here keeps it.
    return (
      <AuthCard
        title="Finish setting up on your first device"
        description="Your key was made on another device, but its backups weren’t finished. Open Trioditis there to finish, then sign in here again."
      >
        <Button block onClick={() => void signOutHere(null)}>
          Sign out
        </Button>
      </AuthCard>
    )
  }
  // A recovery key shown before a reload may not be the one the server kept: say so first. A
  // note for another key means that key lost, and its recovery key won't work.
  const pending = pendingRecoveryCheck(userId)
  if (pending && !acked.current.has(pending.fingerprint)) {
    const installed = backups.find((b) => b.kind === 'recovery')
    return (
      <RecoveryCheckAfterReload
        pending={pending}
        installedKid={kid ?? null}
        installedCt={installed?.ct}
        onDone={() => {
          acked.current.add(pending.fingerprint)
          recheck()
        }}
      />
    )
  }
  if (here) {
    const session: Session = { userId, sessionId, role, kid: here.kid, keyPair: here.keyPair }
    return <SessionContext value={session}>{children}</SessionContext>
  }
  // A key already here was opened with WebCrypto, so only unlocking needs the check.
  if (!canKeepKeys()) return <InsecurePage userId={userId} sessionId={sessionId} />
  return (
    <Unlock
      userId={userId}
      kid={kid!}
      publicKey={publicKey!}
      backups={backups}
      isLeaving={isLeaving}
      sessionId={sessionId}
      token={token}
      onSignOut={() => void signOutHere(kid ?? null)}
      onDone={() => void local.refetch()}
    />
  )
}

/** How long signing out from setup waits for a step under way before going on without it. */
const LEAVE_WAIT_MS = 10_000

/** The session this browser is in, if it's still `sessionId`, the one the page opened with. */
const sessionStill = (userId: string, sessionId: string) =>
  currentSessionId(userId).then((now) => (now === sessionId ? now : null))

/** The key the server has both backups of now, if any (see signOut's backedUpKid). */
async function backedUpNow(sessionId: string): Promise<string | null> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('the server didn’t answer in time')), LEAVE_WAIT_MS),
  )
  // Asked of Convex itself: the app's client would answer from its live subscription, which can
  // still hold the state from before another tab finished the backups. Asked as the page's own
  // session, with the Convex token it was already given for it: nothing goes to the auth server,
  // so no answer can set a cookie, and another tab's sign-in since changes nothing here.
  const read = async () => {
    const token = convexTokenFor(sessionId)
    if (!token) throw new Error('this page has no token for its session')
    const http = new ConvexHttpClient(config.convexUrl)
    http.setAuth(token)
    return http.query(api.keys.identity, {})
  }
  const identity = await Promise.race([read(), timeout])
  return identity.state === 'ready' ? identity.kid : null
}

/** What key setup is for: a new key, or the missing backups of one this device holds. */
interface SetupFor {
  existing?: KeyPair
  /** The backups the server already has for the key; setup makes only the others. */
  has: { password: boolean; recovery: boolean }
}

/**
 * In place of key setup or unlocking on a page that isn't a secure context. The browser keeps
 * WebCrypto, which encrypts this device's copy of the key, from such pages, so without it the key
 * would have nowhere safe to stay.
 */
function InsecurePage({ userId, sessionId }: { userId: string; sessionId: string }) {
  return (
    <AuthCard
      title="This page can’t keep your key"
      description="Open this server over HTTPS, or on localhost, to keep your key on this device. Your browser only allows the encryption that protects it on a secure page."
    >
      <p className="mb-4 text-sm text-muted-foreground">
        This page is <span className="font-mono break-all">{window.location.origin}</span>.
      </p>
      <SignOutButton userId={userId} sessionId={sessionId} />
    </AuthCard>
  )
}

/** What an error says went wrong, for the end of a sentence. */
function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the browser gave no reason'
}

/** Why keeping the key didn't work, to end a sentence: what to do, if it was turned away. */
function because(error: unknown): string {
  return error instanceof KeepRefused ? `: ${error.message}` : ` (${reason(error)}).`
}

/** Lets the browser paint a spinner before a blocking computation like Argon2id. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * First-device setup, or finishing the backups of a key this device already has (`existing`).
 * The server stores only the backups it doesn't have (`has`), so this makes only those: a
 * password backup with the password the person just signed in with, and a recovery key they
 * must confirm saving before anything is sent. Then the device proves it holds the key, and
 * the server stores them.
 */
function KeySetup({
  userId,
  existing,
  has,
  onSaving,
  onLeave,
  onSignOut,
  isLeaving,
  onBackup,
  onRecoveryLost,
  onRecoveryUntracked,
  sessionId,
  token,
  onDone,
}: {
  userId: string
  existing?: KeyPair
  has: SetupFor['has']
  /** A key is shown or being saved: keep this screen until onDone or onLeave. */
  onSaving: () => void
  /** The person gave up keeping the key here after the server saved it; they'll unlock instead. */
  onLeave: () => void
  /** Signs out (the gate's: see KeyGate), naming the key being set up, if there is one yet. */
  onSignOut: (kid: string | null) => void
  /** Signing out has begun: no step starts or moves on after it. */
  isLeaving: () => boolean
  /** A keys.setup call is on its way, for signing out to wait on and learn from. */
  onBackup: (call: Promise<unknown>) => void
  /** Whether the recovery key shown here lost to another device's. */
  onRecoveryLost: (lost: boolean) => void
  /** The recovery key shown here couldn't be noted for checking after a reload. */
  onRecoveryUntracked: () => void
  /** The session the page opened with: a key is kept here only for it. */
  sessionId: string
  /** The session's save token (see KeyGate), or 'failed' when it couldn't be read. */
  token: number | 'failed' | null
  /** Setup is done and the key is kept here, as `kid`. */
  onDone: (kid: string) => Promise<void>
}) {
  const setup = useMutation(api.keys.setup)
  // The password backup must open with the password that signs in, so it's only ever the one
  // just used to sign in or up, which the server has checked. Without it, sign in again.
  const [password] = useState(() => (has.password ? null : takePassword(userId)))
  const [prepared, setPrepared] = useState<{
    keyPair: KeyPair
    setup: ReturnType<typeof makeKeySetup>
    showRecovery: boolean
  } | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once the server has the backups, if keeping the key on this device then failed.
  const [keptKid, setKeptKid] = useState<string | null>(null)
  // Another device installed its recovery key first, so the one shown here doesn't work.
  const [recoveryLost, setRecoveryLost] = useState(false)
  // Set once setup is done and the key kept here, if the shown recovery key lost the race.
  const [finished, setFinished] = useState<string | null>(null)
  // Set when the server has the backups but which recovery key it kept couldn't be checked.
  const [uncheckedKid, setUncheckedKid] = useState<string | null>(null)
  // Another device set up a different key for the account first: this one can't be used.
  const [keyTaken, setKeyTaken] = useState(false)
  // Signing out is the gate's (KeyGate); this names the key it's for, to decide whether its
  // backups are known to exist.
  const signOutButton = (label = 'Sign out') => (
    <Button
      block
      onClick={() =>
        onSignOut(prepared ? keyId(prepared.keyPair.publicKey) : existing ? keyId(existing.publicKey) : null)
      }
    >
      {label}
    </Button>
  )

  /**
   * The account's key as the server has it now, or undefined if that couldn't be read. The app's
   * client answers from its live subscription, which can hold an error; `fresh` asks the server
   * itself, so a retry isn't just the same error again.
   */
  async function readIdentity(fresh = false) {
    try {
      if (fresh) {
        const { data } = await authClient.convex.token({ fetchOptions: { throw: false } })
        if (!data?.token) return undefined
        const http = new ConvexHttpClient(config.convexUrl)
        http.setAuth(data.token)
        return await http.query(api.keys.identity, {})
      }
      // Inside try: with a failed cached result, the client can throw before giving a promise.
      return await convex.query(api.keys.identity, {})
    } catch {
      return undefined
    }
  }

  /** After a failed step: did another device give the account a different key meanwhile? */
  async function takenElsewhere(job: NonNullable<typeof prepared>) {
    const identity = await readIdentity()
    if (!identity || identity.state === 'none' || identity.publicKey === job.setup.args.publicKey) return false
    setKeyTaken(true)
    setBusy(false)
    return true
  }

  async function prepare(event?: React.FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await ready()
      await nextFrame()
      const keyPair = existing ?? generateKeyPair()
      // keys.setup takes both wraps, but stores only the backups it lacks. A wrap for one it has
      // is ignored, so that one is made with a throwaway password and never shown.
      const wrapPassword = password ?? toBase64Url(crypto.getRandomValues(new Uint8Array(24)))
      // Wraps the key (Argon2id, about a second) and opens both wraps again: it throws a
      // SealError unless both give back this key.
      const made = makeKeySetup(keyPair.privateKey, wrapPassword, userId)
      const next = { keyPair, setup: made, showRecovery: !has.recovery }
      // Noted before it's shown, so a reload from here on still checks it (see
      // pendingRecoveryCheck); if it can't be, signing out says so before going back.
      if (
        next.showRecovery &&
        !(await notePendingRecoveryCheck(userId, keyId(keyPair.publicKey), made.args.recovery.ct))
      )
        onRecoveryUntracked()
      setPrepared(next)
      setBusy(false)
      // From the moment a recovery key is shown, this screen stays: if another device finishes
      // setup meanwhile, the person must still learn which recovery key works.
      if (next.showRecovery) onSaving()
      // With the recovery backup already there, there's nothing to confirm.
      if (!next.showRecovery) await finish(next)
    } catch (e) {
      // Nothing has been sent yet, so there's no half-made key to undo.
      setError(
        e instanceof SealError
          ? 'Your key’s backups didn’t check out on this device, so nothing was saved. Try again.'
          : `Your key couldn’t be made on this device (${reason(e)}). Reload the page and try again.`,
      )
      setBusy(false)
    }
  }

  async function finish(job = prepared) {
    if (!job || isLeaving()) return
    setBusy(true)
    setError(null)
    const fail = (message: string) => {
      setError(message)
      setBusy(false)
    }
    // Taken now, not when the recovery key was shown: a proof expires after five minutes.
    let proof: string
    try {
      proof = await proveKey(job.keyPair, sessionId)
    } catch (e) {
      // This page's session isn't the browser's any more: start again as whoever's signed in.
      if (sessionChanged(e)) return window.location.reload()
      if (await takenElsewhere(job)) return
      return fail(errorMessage(e, 'This device couldn’t prove it holds your key. Try again.'))
    }
    // Signing out began while the proof was on its way: no backups start now, so the key's
    // fate is decided by what's already done.
    if (isLeaving()) {
      setBusy(false)
      return
    }
    // Saves were fenced since this page took its token (signing out, in another tab): no backups
    // start now either, since the key they'd be for can't be kept here.
    if (typeof token === 'number' && (await saveToken(userId).catch(() => null)) !== token) {
      return fail(`Your key couldn’t be set up on this device: ${new KeepRefused('fenced').message}`)
    }
    // Signing out may have begun while that was read: then no backups start either.
    if (isLeaving()) {
      setBusy(false)
      return
    }
    let kid: string
    onSaving()
    try {
      const call = setup({ ...job.setup.args, proof, sessionId })
      onBackup(call)
      kid = (await call).kid
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      if (await takenElsewhere(job)) return
      // Still held: trying again ends in the same check below.
      return fail(errorMessage(e, 'The server couldn’t save your key’s backups. Try again.'))
    }
    await check(kid, job)
  }

  /**
   * keys.setup stores only what's missing, so if another device holding this key installed a
   * recovery key a moment before, the one shown here isn't it. Which one the server kept is
   * checked, and only a match, or a clear mismatch, goes on; a failed check can be tried again.
   */
  async function check(kid: string, job: NonNullable<typeof prepared>, fresh = false) {
    setBusy(true)
    setError(null)
    let lost = false
    if (job.showRecovery) {
      const identity = await readIdentity(fresh)
      const installed = identity?.backups.find((b) => b.kind === 'recovery')
      if (!installed) {
        setUncheckedKid(kid)
        setError('Your key’s backups are saved, but this device couldn’t check which recovery key the server kept.')
        setBusy(false)
        return
      }
      lost = installed.ct !== job.setup.args.recovery.ct
      setRecoveryLost(lost)
      onRecoveryLost(lost)
      // Settled here: a reload no longer needs to check it (see pendingRecoveryCheck).
      if (!lost) clearPendingRecoveryCheck()
    }
    setUncheckedKid(null)
    await keep(kid, job.keyPair, lost)
  }

  /** Keeps the key on this device, once the server has its backups. */
  async function keep(kid: string, keyPair: KeyPair, lost: boolean) {
    if (isLeaving()) return
    setBusy(true)
    setError(null)
    try {
      if (typeof token !== 'number') throw new Error('this device couldn’t get ready to keep a key')
      await storeIdentity(userId, kid, keyPair, token, () => sessionStill(userId, sessionId))
    } catch (e) {
      setKeptKid(kid)
      setError(`Your key’s backups are saved, but the key couldn’t be kept on this device${because(e)}`)
      setBusy(false)
      return
    }
    if (isLeaving()) return
    // Done, unless the recovery key shown here lost the race: then say so before going on.
    if (!lost) return complete(kid)
    setKeptKid(null)
    setFinished(kid)
    setBusy(false)
  }

  /** Opens the app with the key kept here; if it won't read back, Try again stays on offer. */
  async function complete(kid: string) {
    if (isLeaving()) return
    try {
      // The gate checks again just before it lets setup go: not while signing out runs.
      await onDone(kid)
      clearPendingRecoveryCheck()
    } catch (e) {
      setFinished(null)
      setKeptKid(kid)
      setError(`Your key’s backups are saved, but the key couldn’t be kept on this device${because(e)}`)
      setBusy(false)
    }
  }

  if (keyTaken) {
    return (
      <AuthCard
        title="Another device set up your key first"
        description="Your account’s key was made on another device a moment ago, so the key made here, and the recovery key shown with it, won’t be used. Unlock with your password to use the one from that device."
      >
        <Button variant="primary" size="lg" block className="mb-2" onClick={onLeave}>
          Unlock with my password
        </Button>
        {signOutButton()}
      </AuthCard>
    )
  }

  if (uncheckedKid && prepared) {
    return (
      <AuthCard
        title="Check your recovery key"
        description="Another device may have finished setting up your key at the same moment. Check which recovery key works before going on."
      >
        <FormError message={error} />
        <Button
          variant="primary"
          size="lg"
          block
          loading={busy}

          onClick={() => void check(uncheckedKid, prepared, true)}
        >
          Check again
        </Button>
        {/* keys.setup succeeded, so signing out forgets this device's copy (see `leave`). */}
        <div className="mt-2">{signOutButton()}</div>
      </AuthCard>
    )
  }

  if (finished && recoveryLost) {
    return (
      <AuthCard
        title="Your recovery key is the other one"
        description="Your key is set up, but another device finished saving its recovery key a moment earlier. The recovery key shown here won’t work: keep the one from that device, or make a new one in Settings → Keys and devices."
      >
        <Button
          variant="primary"
          size="lg"
          block
          className="mb-2"

          onClick={() => void complete(finished)}
        >
          Continue
        </Button>
        {/* The backups are complete and the key is kept here, so signing out forgets it, as ever. */}
        {signOutButton()}
      </AuthCard>
    )
  }

  if (keptKid && prepared) {
    return (
      <AuthCard
        title="Keep your key on this device"
        description="Its backups are saved on the server. If this device can’t keep it, unlock with your password instead."
      >
        <FormError message={error} />
        {/* Unlocking instead leaves this screen, so the warning comes along here. */}
        {recoveryLost ? (
          <p className="mb-4 text-sm text-warning-ink">
            Another device saved its recovery key a moment earlier: the one shown here won’t work. Keep the one from
            that device, or make a new one in Settings → Keys and devices.
          </p>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          block
          className="mb-2"
          loading={busy}

          onClick={() => void keep(keptKid, prepared.keyPair, recoveryLost)}
        >
          Try again
        </Button>
        <Button block className="mb-2" onClick={onLeave}>
          Unlock with my password
        </Button>
        {signOutButton()}
      </AuthCard>
    )
  }

  if (!prepared || !prepared.showRecovery) {
    if (!has.password && !password) {
      return (
        <AuthCard
          title={existing ? 'Finish setting up your key' : 'Set up your key'}
          description="Your key’s backup is protected by the password you sign in with. Sign in again, and setup carries on from there."
        >
          {signOutButton('Sign in again')}
        </AuthCard>
      )
    }
    return (
      <AuthCard
        title={existing ? 'Finish setting up your key' : 'Set up your key'}
        description={
          has.password
            ? 'Your key still needs a recovery key, the way back in if you forget your password.'
            : 'Trioditis seals every message to a key only your devices hold, so the server can’t read them. The password you just used protects a backup of it, so your other devices can open your messages too.'
        }
      >
        <form onSubmit={prepare}>
          <FormError message={error} />
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {busy ? 'Securing your key…' : 'Continue'}
          </Button>
          <div className="mt-2">{signOutButton()}</div>
        </form>
      </AuthCard>
    )
  }

  const recoveryText = prepared.setup.recoveryText
  return (
    <AuthCard
      title="Save your recovery key"
      description="If you forget your password, this is the only way back into your messages. Write it down or keep it in a password manager. It’s shown only now."
    >
      <FormError message={error} />
      <div
        className="mb-3 rounded-md bg-surface-2 p-3 text-center font-mono text-base leading-relaxed tracking-wide break-all shadow-[inset_0_0_0_1px_var(--border)]"
        aria-label="Recovery key"
      >
        {recoveryText}
      </div>
      <Button
        size="sm"
        className="mb-4"
        onClick={() =>
          navigator.clipboard.writeText(recoveryText).then(
            () => setCopied(true),
            () => setError('Copying didn’t work here. Select the key and copy it yourself.'),
          )
        }
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? 'Copied' : 'Copy'}
      </Button>
      <label className="mb-5 flex items-start gap-2.5 text-sm">
        <Checkbox className="mt-0.5" checked={saved} onCheckedChange={(checked) => setSaved(checked === true)} />
        I’ve saved my recovery key somewhere safe.
      </label>
      <Button variant="primary" size="lg" block disabled={!saved} loading={busy} onClick={() => void finish()}>
        Finish setup
      </Button>
      <div className="mt-2">{signOutButton()}</div>
    </AuthCard>
  )
}

type Backup = {
  kid: string
  kind: 'password' | 'recovery' | 'passkey'
  nonce: string
  ct: string
  params?: PasswordParams
  credentialId?: string
  prfSalt?: string
  revision: number
}

function Unlock({
  userId,
  kid,
  publicKey,
  backups,
  isLeaving,
  sessionId,
  token,
  onSignOut,
  onDone,
}: {
  userId: string
  kid: string
  publicKey: string
  backups: Backup[]
  /** Signing out (the gate's) has begun: an unlock that finishes after it doesn't open the app. */
  isLeaving: () => boolean
  /** The session the page opened with: a key is kept here only for it. */
  sessionId: string
  /** The session's save token (see KeyGate), or 'failed' when it couldn't be read. */
  token: number | 'failed' | null
  onSignOut: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState<'secret' | 'passkey' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Passkey backups of this key: each opens with its passkey's PRF output (lib/passkeys.ts).
  const passkeys = backups.filter(
    (b): b is Backup & { credentialId: string; prfSalt: string } =>
      b.kind === 'passkey' && b.kid === kid && !!b.credentialId && !!b.prfSalt,
  )
  const fail = (message: string) => {
    setError(message)
    setBusy(null)
  }

  /** Keeps the opened key on this device, then opens the app. */
  async function keep(keyPair: KeyPair) {
    if (isLeaving()) return
    try {
      if (typeof token !== 'number') throw new Error('this device couldn’t get ready to keep a key')
      await storeIdentity(userId, kid, keyPair, token, () => sessionStill(userId, sessionId))
    } catch (e) {
      return fail(
        e instanceof KeepRefused
          ? `Your key opened, but it couldn’t be kept on this device: ${e.message}`
          : `Your key opened, but it couldn’t be kept on this device (${reason(e)}). Check that this site may store data, then try again.`,
      )
    }
    if (isLeaving()) return
    onDone()
  }

  async function unlock(value: string, how: 'password' | 'recovery') {
    const backup = backups.find((b) => b.kind === how)
    if (!backup)
      return setError(
        how === 'password'
          ? 'There’s no password backup. Use your recovery key.'
          : 'There’s no recovery key backup. Use your password.',
      )
    setBusy('secret')
    setError(null)
    await nextFrame()
    // Each step says what went wrong in it: only a key that doesn't open means a wrong password.
    let wrappingKey: Uint8Array
    try {
      await ready()
      wrappingKey = how === 'password' ? passwordKey(value, backup.params!) : decodeRecoveryKey(value)
    } catch (e) {
      return fail(
        how === 'password'
          ? `Your password couldn’t be checked on this device (${reason(e)}). Reload the page and try again.`
          : // decodeRecoveryKey says whether the text isn't a recovery key or has a typo.
            `${errorMessage(e, 'That isn’t a recovery key')}. Check it and try again.`,
      )
    }
    let keyPair: KeyPair
    try {
      keyPair = unwrapIdentityKey(backup, wrappingKey, { userId, kid, kind: how }, fromBase64Url(publicKey))
    } catch {
      return fail(
        how === 'password'
          ? 'That password doesn’t open your key. Try again, or use your recovery key.'
          : 'That recovery key doesn’t match. Check it and try again.',
      )
    }
    await keep(keyPair)
  }

  /**
   * Opens the key with a passkey backup: with the PRF output signing in just gave (`given`), or by
   * asking one of this key's passkeys for it now.
   */
  async function unlockWithPasskey(given?: PrfResult) {
    setBusy('passkey')
    setError(null)
    let prf: PrfResult
    try {
      prf = given ?? (await evaluatePasskeys(passkeys))
    } catch (e) {
      return fail(
        e instanceof PasskeyCancelled
          ? 'Unlocking with a passkey was cancelled. Try again, or use your password.'
          : e instanceof NoPrf
            ? `${e.message} Use your password instead.`
            : `Your passkey couldn’t be used here (${reason(e)}). Use your password instead.`,
      )
    }
    const backup = passkeys.find((b) => b.credentialId === prf.credentialId)
    if (!backup) return fail('That passkey doesn’t unlock your key. Use another, or your password.')
    let keyPair: KeyPair
    try {
      keyPair = await openPasskeyBackup(backup, prf, userId, fromBase64Url(publicKey))
    } catch {
      return fail('That passkey’s backup didn’t open your key. Use your password, then add the passkey again.')
    }
    await keep(keyPair)
  }

  // Coming straight from sign-in, use what was just given: a passkey's PRF output, if its backup
  // was made with the same input sign-in asked for, or else the password that was just typed.
  // Each is taken once, so this does nothing on later renders.
  useEffect(() => {
    const password = takePassword(userId)
    const prf = takePrf(userId)
    const match = prf && passkeys.find((b) => b.credentialId === prf.credentialId)
    if (!password && !match) return
    // Taken above, before anything waits, so they're never left for another screen.
    void ready().then(() => {
      if (prf && match && match.prfSalt === toBase64Url(passkeyPrfSalt())) void unlockWithPasskey(prf)
      else if (password) void unlock(password, 'password')
    })
  }, [])

  return (
    <AuthCard
      title="Unlock your messages on this device"
      description={
        mode === 'password'
          ? 'Enter your password to open your key here.'
          : 'Enter the recovery key you saved when you set up your account.'
      }
      footer={
        <Button
          variant="link"
          size="sm"
          onClick={() => {
            setMode(mode === 'password' ? 'recovery' : 'password')
            setError(null)
            setSecret('')
          }}
        >
          {mode === 'password' ? 'Use your recovery key instead' : 'Use your password instead'}
        </Button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void unlock(secret, mode)
        }}
      >
        <FormError message={error} />
        <Field label={mode === 'password' ? 'Password' : 'Recovery key'}>
          <Input
            type={mode === 'password' ? 'password' : 'text'}
            autoComplete={mode === 'password' ? 'current-password' : 'off'}
            spellCheck={false}
            className={mode === 'recovery' ? 'font-mono' : undefined}
            required
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy === 'secret'} disabled={busy !== null}>
          {busy === 'secret' ? 'Unlocking…' : 'Unlock'}
        </Button>
        {passkeys.length > 0 ? (
          <Button
            type="button"
            size="lg"
            block
            className="mt-2"
            loading={busy === 'passkey'}
            disabled={busy !== null}
            onClick={() => void unlockWithPasskey()}
          >
            <KeyRound className="size-4" /> Unlock with a passkey
          </Button>
        ) : null}
        <Button type="button" block className="mt-2" onClick={onSignOut}>
          Sign out
        </Button>
      </form>
      <p className="mt-4 flex gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> Your key is opened here, on this device. The
        server can’t open it.
      </p>
    </AuthCard>
  )
}

/** Waits for a step under way, but not for long: one that stalls mustn't hold signing out up. */
const settled = (step: Promise<unknown> | null) =>
  Promise.race([step?.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, LEAVE_WAIT_MS))])

/**
 * Signing out from setup or unlock, on a screen of its own: while it runs, whatever finishes
 * behind it changes nothing on screen. If it fails, Try again, or go back, which reloads the
 * page so it starts again from what the server and this device really hold.
 */
function SignOutProgress({
  state,
  failure,
  onRetry,
  children,
}: {
  state: 'running' | 'failed'
  /** What went wrong, once it has. */
  failure: string
  onRetry: () => void
  children?: ReactNode
}) {
  if (state === 'running') {
    return (
      <AuthCard title="Signing out…" description="Finishing what was under way on this device first.">
        <p className="py-6 text-center text-sm text-muted-foreground" aria-busy="true">
          Signing out…
        </p>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="Couldn’t sign out" description={failure}>
      {children}
      <Button variant="primary" size="lg" block className="mb-2" onClick={onRetry}>
        Try again
      </Button>
      <Button block onClick={() => window.location.reload()}>
        Go back
      </Button>
    </AuthCard>
  )
}

function RecoveryLostNote() {
  return (
    <p className="mb-4 text-sm text-warning-ink">
      Another device saved its recovery key a moment earlier: the one shown here won’t work. Keep the one from that
      device, or make a new one in Settings → Keys and devices.
    </p>
  )
}

// A recovery key shown on this tab, kept (as a fingerprint of its wrap, nothing secret) until
// it's known to be the one the server kept, so a reload before then still checks: two devices
// finishing a key's backups at once each show one, and only one is installed.
const RECOVERY_CHECK = 'trioditis:recovery-check'
interface PendingRecoveryCheck {
  userId: string
  kid: string
  fingerprint: string
}

async function fingerprint(ct: string) {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ct))))
}

/** Notes the recovery key shown, for after a reload. False if it couldn't be noted. */
async function notePendingRecoveryCheck(userId: string, kid: string, ct: string): Promise<boolean> {
  try {
    const note: PendingRecoveryCheck = { userId, kid, fingerprint: await fingerprint(ct) }
    sessionStorage.setItem(RECOVERY_CHECK, JSON.stringify(note))
    return true
  } catch {
    return false
  }
}

function clearPendingRecoveryCheck() {
  try {
    sessionStorage.removeItem(RECOVERY_CHECK)
  } catch {
    // Nothing kept, so nothing to clear.
  }
}

/** The person's noted recovery key, for whichever key it was shown with. */
function pendingRecoveryCheck(userId: string): PendingRecoveryCheck | null {
  try {
    const note = JSON.parse(sessionStorage.getItem(RECOVERY_CHECK) ?? 'null') as PendingRecoveryCheck | null
    return note && note.userId === userId ? note : null
  } catch {
    return null
  }
}

/**
 * After a reload: is the recovery key shown before it the one the server kept? For another key
 * than the server's, it isn't (that key lost); for the same key, its fingerprint says. If that
 * can't be worked out, it says so too, rather than going on as if it were fine.
 */
function RecoveryCheckAfterReload({
  pending,
  installedKid,
  installedCt,
  onDone,
}: {
  pending: PendingRecoveryCheck
  installedKid: string | null
  installedCt: string | undefined
  onDone: () => void
}) {
  const sameKey = pending.kid === installedKid
  const { data: installed, isError } = useQuery({
    queryKey: ['recovery-fingerprint', installedCt],
    queryFn: () => fingerprint(installedCt!),
    enabled: sameKey && !!installedCt,
    retry: false,
    // WebCrypto, not the network: offline mustn't pause it and leave the splash up.
    networkMode: 'always',
  })
  const matches = sameKey && installed !== undefined && installed === pending.fingerprint
  const done = () => {
    clearPendingRecoveryCheck()
    onDone()
  }
  useEffect(() => {
    if (matches) done()
  })
  if (matches || (sameKey && installedCt && installed === undefined && !isError)) return <Splash />
  const unknown = sameKey && (isError || !installedCt)
  return (
    <AuthCard
      title={unknown ? 'Check your recovery key' : 'Your recovery key is the other one'}
      description={
        unknown
          ? 'This device couldn’t check whether the recovery key it showed before is the one your account keeps. If you’re not sure it is, make a new one in Settings → Keys and devices.'
          : 'Another device finished setting up your key at the same time as this one. The recovery key shown here before won’t work: keep the one from that device, or make a new one in Settings → Keys and devices.'
      }
    >
      <Button variant="primary" size="lg" block onClick={done}>
        Continue
      </Button>
    </AuthCard>
  )
}

function RecoveryUntrackedNote() {
  return (
    <p className="mb-4 text-sm text-warning-ink">
      This device couldn’t keep track of the recovery key it showed. After going back, if you’re not sure it’s the one
      your account keeps, make a new one in Settings → Keys and devices.
    </p>
  )
}

/** Signs `userId` out of `sessionId`, the session the screen is for (lib/sign-out.ts). */
export function SignOutButton({
  userId,
  sessionId,
  label = 'Sign out',
}: {
  userId: string
  sessionId: string
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  return (
    <>
      {failure ? (
        <p role="alert" className="mb-2 text-sm text-danger">
          {failure}
        </p>
      ) : null}
      <Button
        block
        loading={busy}
        onClick={async () => {
          setBusy(true)
          setFailure(null)
          const failed = await signOut(userId, sessionId)
          if (failed === null) return
          setFailure(failed)
          setBusy(false)
        }}
      >
        {label}
      </Button>
    </>
  )
}

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-rail" aria-busy="true" aria-label="Loading">
      <img src="/icon.svg" alt="" className="size-10 opacity-80 motion-safe:animate-pulse" />
    </div>
  )
}
