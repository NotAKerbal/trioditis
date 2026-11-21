import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { Link, Navigate, createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { convexQuery } from '@convex-dev/react-query'
import { api } from '@trioditis/backend/api'
import { useQuery } from '@tanstack/react-query'
import { useConvexAuth } from 'convex/react'
import { useState } from 'react'
import { AuthCard, Field, FormError } from '~/features/auth/auth-card.tsx'
import { attempt, errorMessage, tooManyAttempts, UNREACHABLE } from '~/lib/errors.ts'
import { authClient, derivedAuthPassword, lastRetryAfter } from '~/lib/auth-client.ts'
import { announceAccountChange } from '~/lib/account-tabs.ts'
import { desktop, passkeysUnavailable, serverSwitcher } from '~/lib/desktop.ts'
import { holdPassword } from '~/lib/pending-password.ts'
import { holdPrf, signInWithPasskey } from '~/lib/passkeys.ts'
import { peekConsentReturn } from '~/lib/agent-connect.ts'

export const Route = createFileRoute('/sign-in')({ component: SignIn })

// In the desktop app, the server this page belongs to, so a person who picked the wrong one
// can go back to the picker from here, as in other self-hosted apps' sign-in screens.
const server = serverSwitcher(desktop, window.location)

function SignIn() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null)
  // After a sign-out that couldn't confirm removing the key from this device (lib/sign-out.ts).
  const [keyUnconfirmed] = useState(() => new URLSearchParams(window.location.search).get('key') === 'unconfirmed')
  // An agent's consent page sent the person here to sign in first: back there afterwards.
  const [next] = useState(() => {
    const request = peekConsentReturn()
    return request ? ({ to: '/agents/connect', search: { request } } as const) : ({ to: '/' } as const)
  })

  // Signed in already, in another tab (which reloaded this one, lib/account-tabs.ts): the app
  // is where this tab belongs now.
  // Only a session the server still has counts (members.me), not a Convex token that hasn't
  // expired yet: one whose session just ended stays here.
  const { isAuthenticated } = useConvexAuth()
  const me = useQuery(convexQuery(api.members.me, isAuthenticated ? {} : 'skip'))
  async function withPassword(event: React.FormEvent) {
    event.preventDefault()
    setBusy('password')
    setError(null)
    // A request the network rejected comes back as an error too, so the form is never left busy.
    const result = await attempt(async () =>
      authClient.signIn.email({
        email,
        password: await derivedAuthPassword(password, email),
      }),
    )
    setBusy(null)
    if (result.error || !result.data) {
      return setError(
        tooManyAttempts(result.error, lastRetryAfter()) ??
          errorMessage(result.error, 'That email and password didn’t match.'),
      )
    }
    const { data } = result
    announceAccountChange()
    // The same password unlocks the identity key on the next screen.
    holdPassword(password, data.user.id)
    await navigate(next)
  }

  async function withPasskey() {
    setBusy('passkey')
    setError(null)
    const result = await signInWithPasskey().catch((error: unknown) => ({
      error: error instanceof TypeError ? new Error(UNREACHABLE) : error,
    }))
    setBusy(null)
    if ('error' in result)
      return setError(
        tooManyAttempts(result.error, lastRetryAfter()) ??
          errorMessage(result.error, 'Signing in with a passkey didn’t work. Try your password.'),
      )
    announceAccountChange()
    // The same touch gave the passkey's PRF output, if it has one: it unlocks the identity key
    // on the next screen.
    if (result.prf) holdPrf(result.prf, result.userId)
    await navigate(next)
  }

  if (isAuthenticated && me.data) return <Navigate {...next} />

  return (
    <AuthCard
      title="Sign in"
      description={
        server ? (
          <>
            to <span className="font-semibold text-foreground">{server.host}</span>
            {' · '}
            {/* Sized as the sentence it sits in, not as a control. */}
            <Button
              variant="link"
              className="h-auto px-0 align-baseline text-base"
              aria-label="Change server"
              onClick={server.change}
              disabled={busy !== null}
            >
              Change
            </Button>
          </>
        ) : (
          'to your Trioditis server.'
        )
      }
      footer={
        <>
          <p className="mb-2">Forgot your password? Ask your server’s admin for a reset link.</p>
          Setting up a new server?{' '}
          <Link to="/setup" className="font-semibold text-primary hover:underline">
            Create the admin account
          </Link>
        </>
      }
    >
      <form onSubmit={withPassword}>
        {keyUnconfirmed ? (
          <p className="mb-4 rounded-md bg-warning-soft p-3 text-sm text-warning-ink">
            You’re signed out, but this device couldn’t confirm it removed your key. To be sure it’s gone, clear this
            site’s data in your browser’s settings.
          </p>
        ) : null}
        <FormError message={error} />
        <Field label="Email">
          <Input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy === 'password'} disabled={busy !== null}>
          Sign in
        </Button>
      </form>
      <div className="my-4 flex items-center gap-3 text-sm text-subtle-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <Button
        size="lg"
        block
        onClick={withPasskey}
        loading={busy === 'passkey'}
        disabled={busy !== null || !!passkeysUnavailable}
      >
        <KeyRound className="size-4" /> Sign in with a passkey
      </Button>
      {passkeysUnavailable ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          {passkeysUnavailable} Sign in with your password here, or use your passkey in a browser.
        </p>
      ) : null}
    </AuthCard>
  )
}
