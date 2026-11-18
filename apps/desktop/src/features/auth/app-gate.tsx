import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { convexQuery } from '@convex-dev/react-query'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Navigate } from '@tanstack/react-router'
import { useConvexAuth, useMutation as useConvexMutation } from 'convex/react'
import { ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { authClient } from '~/lib/auth-client.ts'
import { createIdentity, loadIdentity } from '~/lib/keys.ts'
import { SessionContext, type Session } from '~/lib/session.tsx'
import { AuthCard, FormError, errorMessage } from './auth-card.tsx'

/**
 * Everything signed in passes through here: the account must be a member of this server, and
 * this device must hold the person's identity key, since nothing can be read without it.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  if (isLoading) return <Splash />
  if (!isAuthenticated) return <Navigate to="/sign-in" />
  return <MemberGate>{children}</MemberGate>
}

function MemberGate({ children }: { children: ReactNode }) {
  const me = useQuery(convexQuery(api.members.me, {}))
  if (me.isPending) return <Splash />
  if (!me.data) {
    return (
      <AuthCard title="This account isn’t on this server" description="It may have been removed. Ask the server’s admin for an invitation.">
        <SignOutButton />
      </AuthCard>
    )
  }
  return (
    <KeyGate member={me.data}>
      {children}
    </KeyGate>
  )
}

type Member = { userId: string; role: 'admin' | 'member'; identityKid: string | null }

function KeyGate({ member, children }: { member: Member; children: ReactNode }) {
  const identity = useQuery({ queryKey: ['identity', member.userId], queryFn: () => loadIdentity(member.userId), staleTime: Infinity })
  if (identity.isPending) return <Splash />
  const local = identity.data
  if (local && local.kid === member.identityKid) {
    const session: Session = { userId: member.userId, role: member.role, kid: local.kid, keyPair: local.keyPair }
    return <SessionContext value={session}>{children}</SessionContext>
  }
  if (!member.identityKid) return <KeySetup userId={member.userId} onDone={() => identity.refetch()} />
  return (
    <AuthCard
      title="This device can’t open your messages yet"
      description="Your messages are sealed to the key on the device you first set up. Restoring that key on another device with your recovery key isn’t available on this server yet."
    >
      <SignOutButton />
    </AuthCard>
  )
}

function KeySetup({ userId, onDone }: { userId: string; onDone: () => void }) {
  const setIdentityKey = useConvexMutation(api.members.setIdentityKey)
  const [error, setError] = useState<string | null>(null)
  const create = useMutation({
    mutationFn: async () => {
      const { publicKey } = await createIdentity(userId)
      await setIdentityKey({ publicKey })
    },
    onSuccess: onDone,
    onError: (e) => setError(errorMessage(e, 'The key couldn’t be saved. Try again.')),
  })
  return (
    <AuthCard
      title="Set up this device"
      description="Trioditis seals every message to a key that only your devices hold, so the server can’t read them. This makes that key on this device."
    >
      <FormError message={error} />
      <ul className="mb-5 space-y-2 text-sm text-muted-foreground">
        <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> The private key stays on this device, encrypted.</li>
        <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" /> You connect your networks once it’s set up.</li>
      </ul>
      <Button variant="primary" size="lg" block loading={create.isPending} onClick={() => create.mutate()}>
        Make my key
      </Button>
    </AuthCard>
  )
}

function SignOutButton() {
  return (
    <Button block onClick={() => authClient.signOut().then(() => window.location.assign('/sign-in'))}>
      Sign out
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
