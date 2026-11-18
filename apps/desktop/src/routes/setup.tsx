import { Link, createFileRoute } from '@tanstack/react-router'
import { AuthCard } from '~/features/auth/auth-card.tsx'
import { SignUpForm } from '~/features/auth/sign-up-form.tsx'

export const Route = createFileRoute('/setup')({ component: Setup })

function Setup() {
  return (
    <AuthCard
      title="Set up this server"
      description="Create the admin account. You can invite everyone else afterwards."
      footer={
        <>
          Already set up?{' '}
          <Link to="/sign-in" className="font-semibold text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SignUpForm askToken submitLabel="Create admin account" />
    </AuthCard>
  )
}
