import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { INVITE_HEADER, authClient, derivedAuthPassword } from '~/lib/auth-client.ts'
import { holdPassword } from '~/lib/pending-password.ts'
import { errorMessage } from '~/lib/errors.ts'
import { Field, FormError } from './auth-card.tsx'

/**
 * Creates an account. Every account starts from a token: the setup token for the first
 * (admin) account, or an invitation's token. The server refuses a sign-up without one.
 */
export function SignUpForm({
  token,
  email: fixedEmail,
  askToken,
  submitLabel,
}: {
  token?: string
  email?: string
  askToken?: boolean
  submitLabel: string
}) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState(fixedEmail ?? '')
  const [password, setPassword] = useState('')
  const [setupToken, setSetupToken] = useState(token ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await authClient.signUp.email({
      name: name.trim() || email.split('@')[0]!,
      email,
      password: await derivedAuthPassword(password, email),
      fetchOptions: { headers: { [INVITE_HEADER]: setupToken.trim() } },
    })
    setBusy(false)
    if (error) return setError(errorMessage(error, 'That account couldn’t be created.'))
    // The same password protects the identity key backup, made on the next screen.
    holdPassword(password)
    await navigate({ to: '/' })
  }

  return (
    <form onSubmit={submit}>
      <FormError message={error} />
      {askToken ? (
        <Field label="Setup token" hint="The installer printed it. It works once, for the first account.">
          <Input
            required
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
          />
        </Field>
      ) : null}
      <Field label="Your name">
        <Input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Email">
        <Input
          type="email"
          autoComplete="username"
          required
          readOnly={!!fixedEmail}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password" hint="At least 12 characters.">
        <Input
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" block loading={busy}>
        {submitLabel}
      </Button>
    </form>
  )
}
