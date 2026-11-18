import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import type { Network } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { ArrowLeft, CheckCircle2, AlertCircle } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'
import { networkName } from '~/data/chats.ts'
import { useBridgeKey } from '~/data/messages.ts'
import { errorMessage } from '~/lib/errors.ts'
import { sealLoginInput } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

// What each error code means for the person. See docs/architecture/bridge-protocol.md, Errors.
const ERRORS: Record<string, string> = {
  bad_credentials: 'The network didn’t accept those details.',
  login_failed: 'The network ended the login. Start again.',
  timeout: 'That took too long. Start again.',
  not_connected: 'The server couldn’t reach the network. Try again in a minute.',
  rate_limited: 'The network asked us to slow down. Wait a few minutes, then try again.',
  unsupported: 'This server can’t log in to that network that way.',
  network_rejected: 'The network refused the login.',
  expired: 'That login expired. Start again.',
}

const INPUT_TYPE: Record<string, string> = {
  password: 'password',
  token: 'password',
  email: 'email',
  phoneNumber: 'tel',
  '2fa_code': 'text',
  url: 'url',
}

/**
 * Connects an account, from the login steps the bridge host sends: one stepper for every
 * network (docs/architecture/client-api.md, The login stepper).
 */
export function LoginStepper({ network, flowId, onClose }: { network: string; flowId: string; onClose: () => void }) {
  const session = useSession()
  const start = useMutation(api.logins.start)
  const submit = useMutation(api.logins.submit)
  const cancel = useMutation(api.logins.cancel)
  const bridgeKey = useBridgeKey()
  const [loginSessionId, setLoginSessionId] = useState<Id<'loginSessions'> | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  const begin = () => {
    setStartError(null)
    setLoginSessionId(null)
    setValues({})
    start({ network: network as Network, ...(flowId ? { flowId } : {}) }).then(setLoginSessionId, (e: unknown) =>
      setStartError(errorMessage(e, 'That login couldn’t start.')),
    )
  }
  // Start once when the stepper opens (StrictMode runs effects twice in development).
  useEffect(() => {
    if (started.current) return
    started.current = true
    begin()
  })

  const { data: login } = useQuery({
    ...convexQuery(api.logins.session, { loginSessionId: loginSessionId! }),
    enabled: !!loginSessionId,
  })
  const step = login?.step
  const done = login?.state === 'complete' || step?.type === 'complete'
  const failed = login?.state === 'error' || step?.type === 'error'

  // A new step clears what was typed for the last one.
  const stepId = step?.stepId
  useEffect(() => setValues({}), [stepId])

  async function send(input: Record<string, string>) {
    if (!loginSessionId || !step || !bridgeKey) return
    setBusy(true)
    try {
      await submit({
        loginSessionId,
        stepId: step.stepId,
        sealed: sealLoginInput(input, loginSessionId, step.stepId, session.userId, bridgeKey),
      })
    } catch (e) {
      setStartError(errorMessage(e, 'That didn’t go through. Try again.'))
    }
    setBusy(false)
  }

  const close = () => {
    if (loginSessionId && !done && !failed) void cancel({ loginSessionId }).catch(() => undefined)
    onClose()
  }

  return (
    <div>
      <button
        type="button"
        onClick={close}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Accounts
      </button>
      <div className="mb-4 flex items-center gap-3">
        <NetworkBadge network={network} label={networkName(network)} size={32} />
        <div>
          <h2 className="text-lg font-bold">Connect {networkName(network)}</h2>
          <p className="text-sm text-muted-foreground">
            Your login details are sealed so only the bridge can use them; Trioditis never stores them.
          </p>
        </div>
      </div>

      {startError ? (
        <Problem message={startError} onRetry={begin} />
      ) : !login || login.state === 'pending' || !step ? (
        <p className="py-8 text-center text-sm text-muted-foreground" aria-busy="true">
          Starting the login with {networkName(network)}…
        </p>
      ) : done ? (
        <div className="rounded-lg bg-surface-2 p-5 text-center">
          <CheckCircle2 className="mx-auto mb-2 size-8 text-success" />
          <p className="font-semibold">{networkName(network)} is connected.</p>
          <p className="mt-1 text-sm text-muted-foreground">Your chats will appear in the list as they sync.</p>
          <Button className="mt-4" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : failed ? (
        <Problem message={ERRORS[step?.error ?? ''] ?? 'The login didn’t finish. Start again.'} onRetry={begin} />
      ) : login.state === 'cancelled' || step.type === 'cancelled' ? (
        <Problem message="The login was cancelled." onRetry={begin} />
      ) : (
        <div className="rounded-lg p-5 shadow-[0_0_0_1px_var(--border)]">
          {step.instructions ? <p className="mb-4 text-base">{step.instructions}</p> : null}
          {step.type === 'displayAndWait' && step.display ? (
            step.display.type === 'qr' && step.display.data ? (
              // A QR code must be dark on light to scan, in either theme.
              <div className="mx-auto w-fit rounded-lg bg-on-color p-4">
                <QRCodeSVG value={step.display.data} size={220} aria-label="QR code to scan with your phone" />
              </div>
            ) : step.display.type === 'code' || step.display.type === 'emoji' ? (
              <p
                className="py-3 text-center font-mono text-xl font-bold tracking-[0.2em]"
                aria-label="Code to enter on your phone"
              >
                {step.display.data}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Waiting for your phone…</p>
            )
          ) : null}
          {step.type === 'displayAndWait' ? (
            <p className="mt-3 text-center text-sm text-subtle-foreground">
              This updates by itself once your phone confirms.
            </p>
          ) : null}

          {step.type === 'userInput' || step.type === 'cookies' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void send(values)
              }}
            >
              {step.type === 'cookies' && step.cookies ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  Sign in at <span className="font-mono">{step.cookies.url}</span> in your browser, then copy these
                  cookies from its developer tools.
                </p>
              ) : null}
              {(step.type === 'userInput'
                ? (step.fields ?? [])
                : (step.cookies?.fields ?? []).map((f) => ({
                    id: f.id,
                    type: 'password',
                    name: f.id,
                    description: undefined,
                  }))
              ).map((f) => (
                <label key={f.id} className="mb-3 block">
                  <span className="mb-1.5 block text-sm font-semibold">{f.name}</span>
                  <Input
                    type={INPUT_TYPE[f.type] ?? 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={values[f.id] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                  {f.description ? (
                    <span className="mt-1 block text-sm text-muted-foreground">{f.description}</span>
                  ) : null}
                </label>
              ))}
              <Button type="submit" variant="primary" loading={busy} disabled={!bridgeKey}>
                Continue
              </Button>
            </form>
          ) : null}
        </div>
      )}
    </div>
  )
}

function Problem({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg bg-danger/10 p-4 text-sm text-danger">
      <p className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0" /> {message}
      </p>
      <Button className="mt-3" size="sm" onClick={onRetry}>
        Start again
      </Button>
    </div>
  )
}
