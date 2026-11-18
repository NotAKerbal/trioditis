import { api } from '@trioditis/backend/api'
import type { KeyPair, PasswordParams } from '@trioditis/crypto'
import { decodeRecoveryKey, fromBase64Url, generateKeyPair, makeKeySetup, passwordKey, ready, unwrapIdentityKey } from '@trioditis/crypto'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { Navigate } from '@tanstack/react-router'
import { useConvexAuth, useMutation } from 'convex/react'
import { Check, Copy, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { authClient } from '~/lib/auth-client.ts'
import { forgetIdentity, loadIdentity, storeIdentity } from '~/lib/keys.ts'
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
  if (remote.isPending || local.isPending || !remote.data) return <Splash />
  const { state, publicKey, kid, backups } = remote.data
  const onDone = () => void local.refetch()
  const here = local.data && local.data.kid === kid ? local.data : null
  if (state === 'none') return <KeySetup userId={userId} onDone={onDone} />
  if (state === 'needsBackup') {
    // The key exists but its backups aren't both there: only a device holding the key can make them.
    if (here) return <KeySetup userId={userId} existing={here.keyPair} onDone={() => void remote.refetch()} />
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
  return <Unlock userId={userId} kid={kid!} publicKey={publicKey!} backups={backups} onDone={onDone} />
}

/** Lets the browser paint a spinner before a blocking computation like Argon2id. */
const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 30))

/**
 * First-device setup, or finishing the backups of a key this device already has (`existing`):
 * the key is wrapped with the person's password and a new recovery key, which they must
 * confirm saving before anything is sent.
 */
function KeySetup({ userId, existing, onDone }: { userId: string; existing?: KeyPair; onDone: () => void }) {
  const setup = useMutation(api.keys.setup)
  const [password, setPassword] = useState(() => takePassword() ?? '')
  const [prepared, setPrepared] = useState<{ keyPair: KeyPair; setup: ReturnType<typeof makeKeySetup> } | null>(null)
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function prepare(event?: React.FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    await ready()
    await nextFrame()
    const keyPair = existing ?? generateKeyPair()
    // Wraps the key with the password (Argon2id, about a second) and a new recovery key.
    setPrepared({ keyPair, setup: makeKeySetup(keyPair.privateKey, password, userId) })
    setBusy(false)
  }

  async function finish() {
    if (!prepared) return
    setBusy(true)
    setError(null)
    try {
      const proof = existing ? await proveKey(existing) : undefined
      const { kid } = await setup({ ...prepared.setup.args, ...(proof ? { proof } : {}) })
      await storeIdentity(userId, kid, prepared.keyPair)
      onDone()
    } catch (e) {
      setError(errorMessage(e, 'Your key couldn’t be saved. Try again.'))
      setBusy(false)
    }
  }

  if (!prepared) {
    return (
      <AuthCard
        title={existing ? 'Finish setting up your key' : 'Set up your key'}
        description="Trioditis seals every message to a key only your devices hold, so the server can’t read them. Your password protects a backup of it, so your other devices can open your messages too."
      >
        <form onSubmit={prepare}>
          <FormError message={error} />
          <Field label="Your password" hint="The one you sign in with.">
            <Input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            {busy ? 'Securing your key…' : 'Continue'}
          </Button>
        </form>
      </AuthCard>
    )
  }

  const recoveryText = prepared.setup.recoveryText
  return (
    <AuthCard title="Save your recovery key" description="If you forget your password, this is the only way back into your messages. Write it down or keep it in a password manager. It’s shown only now.">
      <FormError message={error} />
      <div className="mb-3 rounded-md bg-surface-2 p-3 text-center font-mono text-base leading-relaxed tracking-wide break-all shadow-[inset_0_0_0_1px_var(--border)]" aria-label="Recovery key">
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
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I’ve saved my recovery key somewhere safe.
      </label>
      <Button variant="primary" size="lg" block disabled={!saved} loading={busy} onClick={finish}>
        Finish setup
      </Button>
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
    try {
      await ready()
      const wrappingKey = how === 'password' ? passwordKey(value, backup.params!) : decodeRecoveryKey(value)
      const keyPair = unwrapIdentityKey(backup, wrappingKey, { userId, kid, kind: how }, fromBase64Url(publicKey))
      await storeIdentity(userId, kid, keyPair)
      onDone()
    } catch {
      setError(
        how === 'password'
          ? 'That password doesn’t open your key. Try again, or use your recovery key.'
          : 'That recovery key doesn’t match. Check it and try again.',
      )
      setBusy(false)
    }
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
