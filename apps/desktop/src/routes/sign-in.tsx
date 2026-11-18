import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { AuthCard, Field, FormError } from '~/features/auth/auth-card.tsx'
import { errorMessage } from '~/lib/errors.ts'
import { authClient, derivedAuthPassword } from '~/lib/auth-client.ts'
import { announceAccountChange } from '~/lib/account-tabs.ts'
import { holdPassword } from '~/lib/pending-password.ts'

export const Route = createFileRoute('/sign-in')({ component: SignIn })

function SignIn() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null)
  // After a sign-out that couldn't confirm removing the key from this device (lib/sign-out.ts).
  const [keyUnconfirmed] = useState(() => new URLSearchParams(window.location.search).get('key') === 'unconfirmed')

  async function withPassword(event: React.FormEvent) {
    event.preventDefault()
    setBusy('password')
    setError(null)
    const { data, error } = await authClient.signIn.email({
      email,
      password: await derivedAuthPassword(password, email),
    })
    setBusy(null)
    if (error || !data) return setError(errorMessage(error, 'That email and password didn’t match.'))
    announceAccountChange()
    // The same password unlocks the identity key on the next screen.
    holdPassword(password, data.user.id)
    await navigate({ to: '/' })
  }

  async function withPasskey() {
    setBusy('passkey')
    setError(null)
    const result = await authClient.signIn.passkey()
    setBusy(null)
    if (result?.error)
      return setError(errorMessage(result.error, 'Signing in with a passkey didn’t work. Try your password.'))
    announceAccountChange()
    await navigate({ to: '/' })
  }

  return (
    <AuthCard
      title="Sign in"
      description="to your Trioditis server."
      footer={
        <>
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
      <Button size="lg" block onClick={withPasskey} loading={busy === 'passkey'} disabled={busy !== null}>
        <KeyRound className="size-4" /> Sign in with a passkey
      </Button>
    </AuthCard>
  )
}
