import { api } from '@trioditis/backend/api'
import { Button } from '@trioditis/ui/button'
import { toast } from '@trioditis/ui/toast'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'
import { lastUsed } from '~/lib/agent-connect.ts'
import { errorMessage } from '~/lib/errors.ts'
import { Group, Heading, Loading, Setting } from './layout.tsx'

// The scopes' names as the server stores them on a connection, in a word or two. One the server
// no longer offers shows as its name: it has no tool behind it now (convex/mcp.ts, MCP_SCOPES).
const SCOPE_LABEL: Record<string, string> = { read: 'See networks' }

const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/**
 * Settings → Agents: the agents connected to this account (each approved on the consent page,
 * routes/agents.connect.tsx), what each may do, and Disconnect, which ends its access at once.
 * Every approval is its own connection, so one agent on two machines shows twice.
 */
export function Agents() {
  const { data: connections, isError } = useQuery(convexQuery(api.mcp.listConnections, {}))
  const revoke = useMutation(api.mcp.revokeConnection)
  const [busy, setBusy] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // The app's own address forwards /mcp to the backend, so agents' tokens are bound to it.
  const address = `${window.location.origin}/mcp`

  async function disconnect(id: string, name: string) {
    setBusy(id)
    try {
      if (await revoke({ id })) toast(`${name} disconnected`)
    } catch (e) {
      toast(errorMessage(e, `${name} couldn’t be disconnected. Try again.`))
    }
    setBusy(null)
  }

  return (
    <>
      <Heading title="Agents" />
      <Group title="Connected">
        {connections === undefined ? (
          <div className="px-4 py-3">
            <Loading failed={isError} />
          </div>
        ) : connections.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">No agents connected.</p>
        ) : (
          connections.map((connection) => (
            <Setting
              key={connection.id}
              title={connection.name}
              about={[
                connection.scopes.map((scope) => SCOPE_LABEL[scope] ?? scope).join(', '),
                `Connected ${date.format(connection.createdAt)}`,
                lastUsed(connection.lastUsedAt),
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              <Button
                size="sm"
                variant="ghost"
                loading={busy === connection.id}
                disabled={busy !== null}
                onClick={() => void disconnect(connection.id, connection.name)}
              >
                Disconnect
              </Button>
            </Setting>
          ))
        )}
      </Group>
      <Group title="Connect">
        <Setting title="Server address" about={address}>
          <Button
            size="sm"
            aria-label="Copy server address"
            onClick={() =>
              navigator.clipboard.writeText(address).then(
                () => setCopied(true),
                () => toast('Copying didn’t work here. Select the address and copy it.'),
              )
            }
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          </Button>
        </Setting>
      </Group>
    </>
  )
}
