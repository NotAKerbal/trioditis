import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ConvexHttpClient } from 'convex/browser'
import { useState } from 'react'
import { AuthCard, Field, FormError } from '~/features/auth/auth-card.tsx'
import { ResetRefused, resetPassword, type ResetServer } from '~/features/auth/password-reset.ts'
import { derivedAuthPassword } from '~/lib/auth-client.ts'
import { config } from '~/lib/config.ts'
import { errorMessage, UNREACHABLE } from '~/lib/errors.ts'
import { forgetFragmentToken, takeFragmentToken } from '~/lib/fragment.ts'

// A password reset link, made by an admin in Settings → Members: /reset#token=…. The token is in
// the fragment so it never reaches a server or a proxy's logs, and is kept in this tab until used.
export const Route = createFileRoute('/reset')({ component: Reset })

/** Signed out, so asked of Convex directly rather than through the app's signed-in client. */
function resetServer(): ResetServer {
  const http = new ConvexHttpClient(config.convexUrl)
  return {
    info: (token) => http.query(api.account.resetInfo, { token }),
    challenge: (token) => http.mutation(api.account.resetChallenge, { token }),
    reset: (args) => http.action(api.account.resetPassword, args),
  }
}

function Reset() {
  const [token] = useState(() => takeFragmentToken('reset'))
  const [recoveryKey, setRecoveryKey] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <AuthCard title="This reset link is incomplete" description="Ask your admin to send the link again.">
        <Link to="/sign-in" className="font-semibold text-primary hover:underline">
          Go to sign in
        </Link>
      </AuthCard>
    )
  }
  if (done) {
    return (
      <AuthCard title="Your password is reset" description="You’re signed out everywhere. Sign in with your new password.">
        <Link to="/sign-in" className="font-semibold text-primary hover:underline">
          Sign in
        </Link>
      </AuthCard>
    )
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await resetPassword(resetServer(), token, { recoveryKey, newPassword: password }, derivedAuthPassword)
      forgetFragmentToken('reset')
      setDone(true)
    } catch (e) {
      setError(
        e instanceof ResetRefused
          ? e.message
          : e instanceof TypeError
            ? UNREACHABLE
            : errorMessage(e, 'Your password couldn’t be reset. Try again.'),
      )
    }
    setBusy(false)
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Your recovery key opens your messages, so they stay yours with the new password."
    >
      <form onSubmit={submit}>
        <FormError message={error} />
        <Field label="Recovery key" hint="The one you saved when you set up your account.">
          <Input
            // Not required: an account that never finished setting up its key has none.
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
          />
        </Field>
        <Field label="New password" hint="At least 12 characters.">
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
          Reset password
        </Button>
      </form>
    </AuthCard>
  )
}
