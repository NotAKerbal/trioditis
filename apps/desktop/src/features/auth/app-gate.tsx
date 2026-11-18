import { api } from '@trioditis/backend/api'
import type { KeyPair, PasswordParams } from '@trioditis/crypto'
import {
  decodeRecoveryKey,
  fromBase64Url,
  generateKeyPair,
  makeKeySetup,
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
import { Check, Copy, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { authClient } from '~/lib/auth-client.ts'
import { config } from '~/lib/config.ts'
import { convex } from '~/lib/convex.ts'
import { canKeepKeys, forgetIdentity, loadIdentity, storeIdentity } from '~/lib/keys.ts'
import { takePassword } from '~/lib/pending-password.ts'
import { proveKey } from '~/lib/proof.ts'
import { SessionContext, type Session } from '~/lib/session.tsx'
import { errorMessage } from '~/lib/errors.ts'
import { AuthCard, Field, FormError } from './auth-card.tsx'

/**
 * Everything signed in passes through here: the account must be a member of this server, and
 * this device must hold the person's identity key, since nothing can be read without it.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const signedOut = useConfirmedSignedOut(!isLoading && !isAuthenticated)
  if (isAuthenticated) return <MemberGate>{children}</MemberGate>
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
  const me = useQuery(convexQuery(api.members.me, {}))
  if (me.isPending) return <Splash />
  if (!me.data) {
    return (
      <AuthCard
        title="This account isn’t on this server"
        description="It may have been removed. Ask the server’s admin for an invitation."
      >
        <SignOutButton />
      </AuthCard>
    )
  }
  return (
    <KeyGate userId={me.data.userId} role={me.data.role}>
      {children}
    </KeyGate>
  )
}

function KeyGate({ userId, role, children }: { userId: string; role: 'admin' | 'member'; children: ReactNode }) {
  const remote = useQuery(convexQuery(api.keys.identity, {}))
  const local = useQuery({ queryKey: ['identity', userId], queryFn: () => loadIdentity(userId), staleTime: Infinity })
  // While setup is saving, the server's state turns `ready` before this device has kept the key.
  // Holding the setup screen until it's done keeps its progress, errors and retry on screen.
  const [held, setHeld] = useState<SetupFor | null>(null)
  // The key setup just finished and kept here: it's ready, even before the live query says so
  // (it can lag, or still hold an error from during setup).
  const [setUpKid, setSetUpKid] = useState<string | null>(null)
  const setupScreen = (setupFor: SetupFor) => (
    <KeySetup
      userId={userId}
      existing={setupFor.existing}
      has={setupFor.has}
      onSaving={() => setHeld(setupFor)}
      onLeave={() => setHeld(null)}
      onDone={async (doneKid) => {
        await local.refetch()
        setSetUpKid(doneKid)
        setHeld(null)
        void remote.refetch()
      }}
    />
  )
  if (held) return setupScreen(held)
  if (local.data && setUpKid && local.data.kid === setUpKid) {
    const session: Session = { userId, role, kid: local.data.kid, keyPair: local.data.keyPair }
    return <SessionContext value={session}>{children}</SessionContext>
  }
  if (remote.isPending || local.isPending || !remote.data) return <Splash />
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
    if (!canKeepKeys()) return <InsecurePage />
    return setupScreen(setupFor)
  }
  if (state === 'needsBackup') {
    // The key exists but its backups aren't both there: only a device holding the key can make them.
    return (
      <AuthCard
        title="Finish setting up on your first device"
        description="Your key was made on another device, but its backups weren’t finished. Open Trioditis there to finish, then sign in here again."
      >
        <SignOutButton userId={userId} />
      </AuthCard>
    )
  }
  if (here) {
    const session: Session = { userId, role, kid: here.kid, keyPair: here.keyPair }
    return <SessionContext value={session}>{children}</SessionContext>
  }
  // A key already here was opened with WebCrypto, so only unlocking needs the check.
  if (!canKeepKeys()) return <InsecurePage />
  return (
    <Unlock userId={userId} kid={kid!} publicKey={publicKey!} backups={backups} onDone={() => void local.refetch()} />
  )
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
function InsecurePage() {
  return (
    <AuthCard
      title="This page can’t keep your key"
      description="Open this server over HTTPS, or on localhost, to keep your key on this device. Your browser only allows the encryption that protects it on a secure page."
    >
      <p className="mb-4 text-sm text-muted-foreground">
        This page is <span className="font-mono break-all">{window.location.origin}</span>.
      </p>
      <SignOutButton />
    </AuthCard>
  )
}

/** What an error says went wrong, for the end of a sentence. */
function reason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the browser gave no reason'
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
  onDone,
}: {
  userId: string
  existing?: KeyPair
  has: SetupFor['has']
  /** A key is shown or being saved: keep this screen until onDone or onLeave. */
  onSaving: () => void
  /** The person gave up keeping the key here after the server saved it; they'll unlock instead. */
  onLeave: () => void
  /** Setup is done and the key is kept here, as `kid`. */
  onDone: (kid: string) => Promise<void>
}) {
  const setup = useMutation(api.keys.setup)
  // The password backup must open with the password that signs in, so it's only ever the one
  // just used to sign in or up, which the server has checked. Without it, sign in again.
  const [password] = useState(() => (has.password ? null : takePassword()))
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
    if (!job) return
    setBusy(true)
    setError(null)
    const fail = (message: string) => {
      setError(message)
      setBusy(false)
    }
    // Taken now, not when the recovery key was shown: a proof expires after five minutes.
    let proof: string
    try {
      proof = await proveKey(job.keyPair)
    } catch (e) {
      if (await takenElsewhere(job)) return
      return fail(errorMessage(e, 'This device couldn’t prove it holds your key. Try again.'))
    }
    let kid: string
    onSaving()
    try {
      kid = (await setup({ ...job.setup.args, proof })).kid
    } catch (e) {
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
    }
    setUncheckedKid(null)
    await keep(kid, job.keyPair, lost)
  }

  /** Keeps the key on this device, once the server has its backups. */
  async function keep(kid: string, keyPair: KeyPair, lost: boolean) {
    setBusy(true)
    setError(null)
    try {
      await storeIdentity(userId, kid, keyPair)
    } catch (e) {
      setKeptKid(kid)
      setError(`Your key’s backups are saved, but the key couldn’t be kept on this device (${reason(e)}).`)
      setBusy(false)
      return
    }
    // Done, unless the recovery key shown here lost the race: then say so before going on.
    if (!lost) {
      await onDone(kid)
      return
    }
    setKeptKid(null)
    setFinished(kid)
    setBusy(false)
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
        <SignOutButton />
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
        <div className="mt-2">
          <SignOutButton />
        </div>
      </AuthCard>
    )
  }

  if (finished && recoveryLost) {
    return (
      <AuthCard
        title="Your recovery key is the other one"
        description="Your key is set up, but another device finished saving its recovery key a moment earlier. The recovery key shown here won’t work: keep the one from that device, or make a new one in Settings → Keys and devices."
      >
        <Button variant="primary" size="lg" block className="mb-2" onClick={() => void onDone(finished)}>
          Continue
        </Button>
        {/* The backups are complete and the key is kept here, so signing out forgets it, as ever. */}
        <SignOutButton userId={userId} />
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
        <SignOutButton />
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
          <SignOutButton label="Sign in again" />
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
      <div className="mt-2">
        <SignOutButton />
      </div>
    </AuthCard>
  )
}

type Backup = { kind: 'password' | 'recovery' | 'passkey'; nonce: string; ct: string; params?: PasswordParams }

function Unlock({
  userId,
  kid,
  publicKey,
  backups,
  onDone,
}: {
  userId: string
  kid: string
  publicKey: string
  backups: Backup[]
  onDone: () => void
}) {
  const [mode, setMode] = useState<'password' | 'recovery'>('password')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function unlock(value: string, how: 'password' | 'recovery') {
    const backup = backups.find((b) => b.kind === how)
    if (!backup)
      return setError(
        how === 'password'
          ? 'There’s no password backup. Use your recovery key.'
          : 'There’s no recovery key backup. Use your password.',
      )
    setBusy(true)
    setError(null)
    await nextFrame()
    const fail = (message: string) => {
      setError(message)
      setBusy(false)
    }
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
    try {
      await storeIdentity(userId, kid, keyPair)
    } catch (e) {
      return fail(
        `Your key opened, but it couldn’t be kept on this device (${reason(e)}). Check that this site may store data, then try again.`,
      )
    }
    onDone()
  }

  // Coming straight from sign-in, try the password that was just typed. It is taken once, so
  // this does nothing on later renders.
  useEffect(() => {
    const password = takePassword()
    if (password) void unlock(password, 'password')
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
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>
      <p className="mt-4 flex gap-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> Your key is opened here, on this device. The
        server can’t open it.
      </p>
    </AuthCard>
  )
}

export function SignOutButton({ userId, label = 'Sign out' }: { userId?: string; label?: string }) {
  return (
    <Button
      block
      onClick={async () => {
        if (userId) await forgetIdentity(userId)
        await authClient.signOut()
        window.location.assign('/sign-in')
      }}
    >
      {label}
    </Button>
  )
}

export function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-rail" aria-busy="true" aria-label="Loading">
      <img src="/icon.svg" alt="" className="size-10 opacity-80 motion-safe:animate-pulse" />
    </div>
  )
}
