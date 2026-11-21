import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { useAction } from 'convex/react'
import { useEffect, useState, type ReactNode } from 'react'
import { AppGate } from '~/features/auth/app-gate.tsx'
import { AuthCard, FormError } from '~/features/auth/auth-card.tsx'
import { dropConsentReturn, holdConsentReturn, isRequestId, returnsTo } from '~/lib/agent-connect.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { useSession } from '~/lib/session.tsx'

// Where an agent sends the person to approve it (the MCP server's consentUrl, convex/mcp.ts):
// /agents/connect?request=…. The agent registered itself and asked for scopes; the person, signed
// in here, sees which agent, what it may do, where approval returns and as which account, and
// allows or denies it. Allowing makes a connection owned by that account, which Settings → Agents
// lists and can disconnect.
export const Route = createFileRoute('/agents/connect')({
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    isRequestId(search.request) ? { request: search.request } : {},
  component: AgentConnect,
})

// Framed in another site's page, a click here could be made without the person knowing what it
// approves; the page refuses to show the choice at all (docs/PLAN.md, Agents).
const framed = (() => {
  try {
    return window.top !== window.self
  } catch {
    return true
  }
})()

function AgentConnect() {
  const { request } = Route.useSearch()
  // Someone who has to sign in first comes back here afterwards (routes/sign-in.tsx). Held as the
  // page first renders, before the gate can send it to sign in; Consent lets go of it once shown.
  useState(() => request && !framed && holdConsentReturn(request))
  if (framed) {
    return (
      <AuthCard title="Open this page on its own" description="Agents can only be approved outside other sites.">
        {null}
      </AuthCard>
    )
  }
  if (!request) return <Ended title="This link is incomplete" />
  return (
    <AppGate>
      <Consent requestId={request} />
    </AppGate>
  )
}

function Ended({ title }: { title: string }) {
  return (
    <AuthCard title={title} description="Start connecting again from your agent.">
      {null}
    </AuthCard>
  )
}

function Consent({ requestId }: { requestId: string }) {
  const session = useSession()
  const { data: request, isPending, isError } = useQuery(convexQuery(api.mcp.getAuthRequest, { requestId }))
  const { data: me } = useQuery(convexQuery(api.auth.getCurrentUser, {}))
  const authorize = useAction(api.mcp.authorize)
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Back to the agent, once decided; the page stays as it is until the browser leaves.
  const [leaving, setLeaving] = useState<'allowed' | 'denied' | null>(null)

  // Reached the choice signed in: sign-in has nowhere to bring this tab back to now.
  useEffect(() => dropConsentReturn(), [])

  async function decide(approve: boolean) {
    setBusy(approve ? 'allow' : 'deny')
    setError(null)
    try {
      const { redirectUrl } = await authorize({ requestId, approve, sessionId: session.sessionId })
      setLeaving(approve ? 'allowed' : 'denied')
      if (redirectUrl) window.location.assign(redirectUrl)
    } catch (e) {
      // Another tab signed in as someone else: approving now would connect the agent to them.
      if (sessionChanged(e)) return window.location.reload()
      setError(errorMessage(e, 'That didn’t work. Start again from your agent.'))
    }
    setBusy(null)
  }

  if (leaving) {
    return (
      <AuthCard
        title={leaving === 'allowed' ? 'Agent connected' : 'Agent not connected'}
        description="Go back to your agent."
      >
        {null}
      </AuthCard>
    )
  }
  if (isError) return <Ended title="This request couldn’t be loaded" />
  if (isPending)
    return (
      <AuthCard title="Connect an agent" description="Loading…">
        {null}
      </AuthCard>
    )
  // Expired, already used, or never made here.
  if (!request) return <Ended title="This link has expired" />
  if (request.status !== 'pending') return <Ended title="This request was already answered" />
  // This server turns the device flow off (convex/mcp.ts); a request made that way isn't one to approve here.
  if (request.kind !== 'redirect') return <Ended title="This kind of request isn’t supported" />

  const destination = returnsTo(request.redirectUri)
  return (
    <AuthCard title="Connect an agent">
      <FormError message={error} />
      <dl className="space-y-3 text-base">
        <Row label="Agent">
          <span className="font-semibold">{request.clientName ?? 'An unnamed agent'}</span>
          {/* The agent names itself when it registers; nothing checks it. */}
          <span className="block text-sm text-muted-foreground">Name given by the agent</span>
        </Row>
        {destination ? <Row label="Returns to">{destination}</Row> : null}
        <Row label="Can">
          <ul className="list-disc pl-5">
            {request.scopes.map((scope) => (
              <li key={scope.name}>{scope.description}</li>
            ))}
          </ul>
        </Row>
        <Row label="As">{me?.email ?? '…'}</Row>
      </dl>
      <div className="mt-6 flex gap-2">
        <Button
          variant="primary"
          size="lg"
          className="flex-1"
          loading={busy === 'allow'}
          disabled={busy !== null || !me}
          onClick={() => void decide(true)}
        >
          Allow
        </Button>
        <Button
          size="lg"
          className="flex-1"
          loading={busy === 'deny'}
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          Deny
        </Button>
      </div>
    </AuthCard>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
