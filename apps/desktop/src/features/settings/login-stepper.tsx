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
import { loginInputBlocked } from '~/data/bridge-ready.ts'
import { useBridge } from '~/data/messages.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { sealLoginInput } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'
import { canSubmit, initialSubmit, submitReducer, type SubmitEvent } from './login-submit.ts'

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
  const bridge = useBridge()
  const bridgeKey = bridge.key
  const [loginSessionId, setLoginSessionId] = useState<Id<'loginSessions'> | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  // Each step's input goes once (login-submit.ts). The ref holds the same state as `submission`,
  // up to date between renders, so a second submit in the same moment is refused too.
  const [submission, setSubmission] = useState(initialSubmit)
  const latest = useRef(initialSubmit)
  const dispatch = (event: SubmitEvent) => {
    latest.current = submitReducer(latest.current, event)
    setSubmission(latest.current)
  }
  const attempts = useRef(0)
  const started = useRef(false)
  // The login this stepper is running, for leaving it: whichever way the stepper closes
  // (Accounts, Escape, the dialog's close button, another section), an unfinished login is
  // cancelled, including one whose start answers only after the stepper has gone.
  const live = useRef<{ id: Id<'loginSessions'> | null; over: boolean; closed: boolean }>({
    id: null,
    over: false,
    closed: false,
  })
  const abandon = (id: Id<'loginSessions'>) => void cancel({ loginSessionId: id }).catch(() => undefined)

  const begin = () => {
    setStartError(null)
    setLoginSessionId(null)
    setValues({})
    dispatch({ type: 'step', stepId: null })
    live.current = { id: null, over: false, closed: live.current.closed }
    const run = live.current
    // Bound to the session the page opened with: a page another tab has since signed out of, or
    // into someone else, can't start a login for the wrong account (sessionChanged).
    start({ network: network as Network, ...(flowId ? { flowId } : {}), sessionId: session.sessionId }).then(
      (id) => {
        run.id = id
        if (run.closed || live.current !== run) abandon(id)
        else setLoginSessionId(id)
      },
      (e: unknown) => {
        if (sessionChanged(e)) return window.location.reload()
        if (live.current === run) setStartError(errorMessage(e, 'That login couldn’t start.'))
      },
    )
  }
  // Start once when the stepper opens (StrictMode runs effects twice in development).
  useEffect(() => {
    if (started.current) return
    started.current = true
    begin()
  })
  useEffect(() => {
    live.current.closed = false
    return () => {
      // StrictMode unmounts and mounts again at once in development: wait a moment, and leave
      // the login be if the stepper came back.
      const run = live.current
      run.closed = true
      setTimeout(() => {
        if (run.closed && run.id && !run.over) abandon(run.id)
      }, 0)
    }
  }, [])

  const { data: login } = useQuery({
    ...convexQuery(api.logins.session, loginSessionId ? { loginSessionId } : 'skip'),
  })
  const step = login?.step
  const done = login?.state === 'complete' || step?.type === 'complete'
  const failed = login?.state === 'error' || step?.type === 'error'
  const cancelled = login?.state === 'cancelled' || step?.type === 'cancelled'
  // A login that's over needs no cancelling on the way out.
  const over = done || failed || cancelled || login === null
  useEffect(() => {
    live.current.over = over
  }, [over])

  // A new step clears what was typed for the last one, and can be sent.
  const stepId = step?.stepId
  useEffect(() => {
    setValues({})
    dispatch({ type: 'step', stepId: stepId ?? null })
  }, [stepId])

  async function send(input: Record<string, string>) {
    if (!loginSessionId || !step || !bridgeKey || !canSubmit(latest.current, step.stepId)) return
    const sentStepId = step.stepId
    const attempt = ++attempts.current
    dispatch({ type: 'send', stepId: sentStepId, attempt })
    try {
      await submit({
        loginSessionId,
        stepId: sentStepId,
        sealed: sealLoginInput(input, loginSessionId, sentStepId, session.userId, bridgeKey),
      })
      dispatch({ type: 'sent', attempt })
    } catch (e) {
      // The server's sentence, as it is. The person can send again; nothing retries for them.
      dispatch({ type: 'failed', attempt, message: errorMessage(e, 'That didn’t go through. Try again.') })
    }
  }

  // Closing unmounts the stepper, which cancels an unfinished login (above).
  const close = onClose

  return (
    <div>
      <Button
        variant="bare"
        type="button"
        onClick={close}
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Accounts
      </Button>
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
      ) : login === null ? (
        <Problem message="That login is gone. Start again." onRetry={begin} />
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
      ) : cancelled ? (
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
            <>
              <p className="mt-3 text-center text-sm text-subtle-foreground">
                This updates by itself once your phone confirms.
              </p>
              <div className="mt-4 flex justify-center">
                <Button variant="ghost" size="sm" onClick={close}>
                  Cancel
                </Button>
              </div>
            </>
          ) : null}

          {step.type === 'userInput' || step.type === 'cookies' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                // An optional cookie left blank is one the person doesn't have: it isn't sent.
                void send(
                  step.type === 'cookies'
                    ? Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''))
                    : values,
                )
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
                    name: f.required ? f.id : `${f.id} (optional)`,
                    description: undefined,
                    required: f.required,
                  }))
              ).map((f) => (
                <label key={f.id} className="mb-3 block">
                  <span className="mb-1.5 block text-sm font-semibold">{f.name}</span>
                  <Input
                    type={INPUT_TYPE[f.type] ?? 'text'}
                    autoComplete="off"
                    spellCheck={false}
                    required={'required' in f ? f.required : true}
                    disabled={submission.sentStepId === step.stepId || !!loginInputBlocked(bridge.status)}
                    value={values[f.id] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                  />
                  {f.description ? (
                    <span className="mt-1 block text-sm text-muted-foreground">{f.description}</span>
                  ) : null}
                </label>
              ))}
              {loginInputBlocked(bridge.status) ? (
                <p className="mb-3 text-sm text-muted-foreground">{loginInputBlocked(bridge.status)}</p>
              ) : null}
              {submission.error ? (
                <p role="alert" className="mb-3 text-sm text-danger">
                  {submission.error}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  loading={submission.sending || bridge.status === 'loading'}
                  disabled={!bridgeKey || submission.sentStepId === step.stepId}
                >
                  Continue
                </Button>
                <Button type="button" variant="ghost" onClick={close}>
                  Cancel
                </Button>
              </div>
              {submission.sentStepId === step.stepId && !submission.sending ? (
                <p className="mt-3 text-sm text-subtle-foreground" aria-live="polite">
                  Sent. Waiting for {networkName(network)}…
                </p>
              ) : null}
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
