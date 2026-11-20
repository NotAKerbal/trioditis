import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import {
  contactKey,
  parseIdentifier,
  START_TARGETS,
  type Network,
  type NetworkContact,
  type PersonPlaintext,
} from '@trioditis/core'
import type { ErrorCode } from '@trioditis/core/bridge-protocol'
import { fromBase64Url, sealJson } from '@trioditis/crypto'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import { useMutation } from 'convex/react'
import { useEffect, useState } from 'react'
import { networkName, useAccounts } from '~/data/chats.ts'
import { useBridge } from '~/data/messages.ts'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { newClientId } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

// Starting a chat: with a contact (by ghost ID) or a phone number or username, sealed to the
// bridge key. See client-api.md, New chats.

export type ChatTarget = { ghostId: string } | { identifier: string }

/** A connected account that can start chats, and what it can start them from. */
export interface StartableAccount {
  networkAccountId: Id<'networkAccounts'>
  network: Network
}

/** The person's connected accounts that can start chats, in the order they connected. */
export function useStartableAccounts(): StartableAccount[] {
  const accounts = useAccounts()
  return (accounts ?? []).flatMap((a) =>
    a.state === 'CONNECTED' && START_TARGETS[a.network] ? [{ networkAccountId: a._id, network: a.network }] : [],
  )
}

/** What the New chat field asks for on a network, or null where it can't start from one. */
export function identifierPrompt(network: Network): string | null {
  const t = START_TARGETS[network]
  if (t?.phone && t.username) return 'Phone number or username'
  if (t?.phone) return 'Phone number'
  if (t?.username) return 'Username'
  return null
}

/** What to tell the person when a chat couldn't start. */
export function startError(code: ErrorCode | undefined, network: Network): string {
  const name = networkName(network)
  if (code === 'not_found') return `No one on ${name} has that number or username.`
  if (code === 'unsupported') return `${name} can’t start chats from here.`
  if (code === 'not_connected') return `Your ${name} account isn’t connected.`
  if (code === 'rate_limited') return `${name} is limiting new chats. Try again later.`
  if (code === 'expired' || code === 'timeout') return `${name} didn’t answer. Try again.`
  return `${name} couldn’t start that chat.`
}

/**
 * Starts a chat and follows it until there's a chat to open (`onStarted`) or a reason there
 * isn't (`error`). `busy` is true from the moment it's asked until the answer.
 */
export function useStartChat(onStarted: (chatId: Id<'chats'>) => void) {
  const session = useSession()
  const bridge = useBridge()
  const start = useMutation(api.newChats.start)
  const [request, setRequest] = useState<{ requestId: string; network: Network } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { data: status } = useQuery({
    ...convexQuery(api.newChats.status, { requestId: request?.requestId ?? '' }),
    enabled: !!request,
  })

  useEffect(() => {
    if (!request || status === undefined || status?.state === 'pending') return
    setRequest(null)
    // Null: the request is gone (kept only a day), so there's no answer to wait for.
    if (status?.state === 'started' && status.chatId) onStarted(status.chatId)
    else setError(startError(status?.error, request.network))
  }, [status, request, onStarted])

  async function begin(network: Network, networkAccountId: Id<'networkAccounts'>, target: ChatTarget) {
    setError(null)
    const requestId = newClientId()
    try {
      if ('ghostId' in target) {
        await start({ networkAccountId, requestId, ghostId: target.ghostId, sessionId: session.sessionId })
      } else {
        if (!bridge.key) return setError('Trioditis isn’t ready to start chats yet. Try again in a moment.')
        const sealedIdentifier = sealJson(
          { identifier: target.identifier },
          [{ publicKey: fromBase64Url(bridge.key) }],
          {
            kind: 'outbound',
            ownerUserId: session.userId,
            objectId: requestId,
          },
        )
        await start({ networkAccountId, requestId, sealedIdentifier, sessionId: session.sessionId })
      }
      setRequest({ requestId, network })
    } catch (err) {
      if (sessionChanged(err)) return window.location.reload()
      setError(errorMessage(err, `${networkName(network)} couldn’t start that chat.`))
    }
  }

  return { begin, busy: !!request, error, clearError: () => setError(null) }
}

/** A way to start a chat with someone on one account: what the menu says, and what's asked for. */
export interface ChatOption {
  network: Network
  networkAccountId: Id<'networkAccounts'>
  label: string
  target: ChatTarget
}

// The username services that are networks a chat can start on from a username.
const USERNAME_NETWORKS: Record<string, Network> = {
  signal: 'signal',
  twitter: 'twitter',
}

/**
 * The ways a card offers to start a chat on these accounts, as each network's connector can
 * (START_TARGETS): its linked contacts first, on the account that sent them (the chat they
 * already have, or a new one), then its numbers on networks that find people by number, and
 * its usernames on their own network, each on the first account there.
 */
export function chatOptions(
  card: PersonPlaintext,
  accounts: readonly StartableAccount[],
  byContact: ReadonlyMap<string, NetworkContact>,
): ChatOption[] {
  const out: ChatOption[] = []
  const first = (network: Network) => accounts.find((a) => a.network === network)
  for (const link of card.links ?? []) {
    if (!START_TARGETS[link.network]?.contact) continue
    const contact = byContact.get(contactKey(link))
    const account =
      accounts.find((a) => a.network === link.network && a.networkAccountId === contact?.networkAccountId) ??
      first(link.network)
    if (!account) continue
    out.push({
      network: link.network,
      networkAccountId: account.networkAccountId,
      label: contact?.profile.name || 'Contact',
      target: { ghostId: link.ghostId },
    })
  }
  const linked = new Set(out.map((o) => o.network))
  const add = (network: Network, label: string, identifier: string) => {
    const account = first(network)
    if (account && !linked.has(network)) {
      out.push({ network, networkAccountId: account.networkAccountId, label, target: { identifier } })
    }
  }
  for (const network of Object.keys(START_TARGETS) as Network[]) {
    if (!START_TARGETS[network]?.phone) continue
    for (const phone of card.phones ?? []) add(network, phone.value, phone.value)
  }
  for (const handle of card.handles ?? []) {
    const id = parseIdentifier(handle.value)
    const network = id?.kind === 'username' ? USERNAME_NETWORKS[id.service] : undefined
    if (id?.kind === 'username' && network && START_TARGETS[network]?.username) add(network, `@${id.value}`, id.value)
  }
  return out
}
