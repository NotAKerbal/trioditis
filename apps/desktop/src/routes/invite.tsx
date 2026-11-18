import { Link, createFileRoute } from '@tanstack/react-router'
import { AuthCard } from '~/features/auth/auth-card.tsx'
import { SignUpForm } from '~/features/auth/sign-up-form.tsx'

// An invitation link: /invite?token=…&email=…, made by an admin in Settings → Members.
export const Route = createFileRoute('/invite')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
    email: typeof search.email === 'string' ? search.email : '',
  }),
  component: Invite,
})

function Invite() {
  const { token, email } = Route.useSearch()
  if (!token || !email) {
    return (
      <AuthCard title="This invitation link is incomplete" description="Ask whoever invited you to send the link again.">
        <Link to="/sign-in" className="font-semibold text-primary hover:underline">Go to sign in</Link>
      </AuthCard>
    )
  }
  return (
    <AuthCard title="You’re invited" description={`Create your account for ${email}.`}>
      <SignUpForm token={token} email={email} submitLabel="Create account" />
    </AuthCard>
  )
}
