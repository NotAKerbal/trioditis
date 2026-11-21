import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard } from '~/features/auth/auth-card.tsx'
import { SignUpForm } from '~/features/auth/sign-up-form.tsx'
import { desktop, desktopInvitation } from '~/lib/desktop.ts'
import { forgetFragmentToken, takeFragmentToken } from '~/lib/fragment.ts'

// An invitation link, made in Settings → Members: /invite?email=…#token=…. The token is in the
// fragment so it never reaches a server or a proxy's logs. It is kept in this tab until the account
// is made, so reloading the page before then still works.
export const Route = createFileRoute('/invite')({
  validateSearch: (search: Record<string, unknown>) => ({
    email: typeof search.email === 'string' ? search.email : '',
  }),
  component: Invite,
})

function Invite() {
  const { email } = Route.useSearch()
  const remember = `invite:${email}`
  const [token] = useState(() => takeFragmentToken(remember))
  if (!token || !email) {
    return (
      <AuthCard
        title="This invitation link is incomplete"
        description="Ask whoever invited you to send the link again."
      >
        <Link to="/sign-in" className="font-semibold text-primary hover:underline">
          Go to sign in
        </Link>
      </AuthCard>
    )
  }
  const inApp = desktopInvitation(desktop, window.location, email, token)
  return (
    <AuthCard title="You’re invited" description={`Create your account for ${email}.`}>
      <SignUpForm
        token={token}
        email={email}
        submitLabel="Create account"
        onCreated={() => forgetFragmentToken(remember)}
      />
      {inApp ? (
        <p className="mt-4 text-center text-sm">
          <a href={inApp} className="font-semibold text-primary hover:underline">
            Open in the desktop app
          </a>
        </p>
      ) : null}
    </AuthCard>
  )
}
