import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { AuthCard, Field, FormError, errorMessage } from '~/features/auth/auth-card.tsx'
import { authClient } from '~/lib/auth-client.ts'

export const Route = createFileRoute('/sign-in')({ component: SignIn })

function SignIn() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'password' | 'passkey' | null>(null)

  async function withPassword(event: React.FormEvent) {
    event.preventDefault()
    setBusy('password')
    setError(null)
    const { error } = await authClient.signIn.email({ email, password })
    setBusy(null)
    if (error) return setError(errorMessage(error, 'That email and password didn’t match.'))
    await navigate({ to: '/' })
  }

  async function withPasskey() {
    setBusy('passkey')
    setError(null)
    const result = await authClient.signIn.passkey()
    setBusy(null)
    if (result?.error) return setError(errorMessage(result.error, 'Signing in with a passkey didn’t work. Try your password.'))
    await navigate({ to: '/' })
  }

  return (
    <AuthCard
      title="Sign in"
      description="to your Trioditis server."
      footer={
        <>
          Setting up a new server? <Link to="/setup" className="font-semibold text-primary hover:underline">Create the admin account</Link>
        </>
      }
    >
      <form onSubmit={withPassword}>
        <FormError message={error} />
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
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
