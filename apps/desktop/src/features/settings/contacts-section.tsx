import { api } from '@trioditis/backend/api'
import { googleClientIdProblem } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import { Input } from '@trioditis/ui/input'
import { toast } from '@trioditis/ui/toast'
import { useMutation } from 'convex/react'
import { Check, Copy } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { useGoogleClientId } from '~/data/google-contacts.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { googleRedirectUri } from '~/lib/google-sign-in.ts'
import { useSession } from '~/lib/session.tsx'
import { Group, Heading, Loading, Setting } from './layout.tsx'

/**
 * Admin settings → Contacts: the Google client ID people sign in to Google with to bring their
 * contacts into People. Without one, People says how to import an export file instead.
 */
export function Contacts() {
  const clientId = useGoogleClientId()
  return (
    <>
      <Heading title="Contacts" />
      {clientId === undefined ? <Loading /> : <GoogleContacts clientId={clientId} />}
    </>
  )
}

function GoogleContacts({ clientId }: { clientId: string | null }) {
  const session = useSession()
  const save = useMutation(api.google.setContacts)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const problem = value.trim() ? googleClientIdProblem(value) : null

  async function write(next: string | null) {
    setBusy(true)
    try {
      await save({ clientId: next, sessionId: session.sessionId })
      setEditing(false)
      setValue('')
      requestAnimationFrame(() => opener.current?.focus())
    } catch (e) {
      if (sessionChanged(e)) return window.location.reload()
      toast(errorMessage(e, 'That couldn’t be saved.'))
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!problem) void write(value.trim())
  }

  return (
    <Group title="Google Contacts">
      <Setting
        title="Client ID"
        about={clientId ?? 'Not set up. People can still import a file exported from Google.'}
        below={
          editing ? (
            <form className="grid max-w-[520px] gap-3" onSubmit={submit}>
              <p className="text-sm text-muted-foreground">
                In Google Cloud, turn on the People API, and make an OAuth client of type Web application with these:
              </p>
              <CopyRow label="Authorized JavaScript origin" value={window.location.origin} />
              <CopyRow label="Authorized redirect URI" value={googleRedirectUri()} />
              <Input
                autoFocus
                required
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="…apps.googleusercontent.com"
                aria-label="Client ID"
                aria-invalid={!!problem}
                spellCheck={false}
              />
              {problem ? (
                <p role="alert" className="text-sm text-danger">
                  {problem}
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button type="submit" variant="primary" loading={busy} disabled={!value.trim() || !!problem}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEditing(false)
                    setValue('')
                    requestAnimationFrame(() => opener.current?.focus())
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : null
        }
      >
        {editing ? null : (
          <div className="flex gap-2">
            {clientId ? (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void write(null)}>
                Remove
              </Button>
            ) : null}
            <Button ref={opener} size="sm" onClick={() => setEditing(true)}>
              {clientId ? 'Change' : 'Set up'}
            </Button>
          </div>
        )}
      </Setting>
    </Group>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{label}</div>
        <div className="truncate font-mono text-sm text-muted-foreground">{value}</div>
      </div>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => toast('Copying didn’t work here. Select it and copy it.'),
          )
        }
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
