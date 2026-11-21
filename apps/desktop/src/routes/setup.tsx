import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthCard } from '~/features/auth/auth-card.tsx'
import { SignUpForm } from '~/features/auth/sign-up-form.tsx'
import { forgetFragmentToken, takeFragmentToken } from '~/lib/fragment.ts'

// First-run setup. The installer prints a link with the setup token in its fragment,
// /setup#token=…; opened that way the token is filled in already, and stays filled in across a
// reload until the account is made.
export const Route = createFileRoute('/setup')({ component: Setup })

function Setup() {
  const [token] = useState(() => takeFragmentToken('setup'))
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
      <SignUpForm
        askToken
        token={token}
        submitLabel="Create admin account"
        onCreated={() => forgetFragmentToken('setup')}
      />
    </AuthCard>
  )
}
