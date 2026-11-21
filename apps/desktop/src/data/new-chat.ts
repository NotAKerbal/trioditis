import { api } from '@trioditis/backend/api'
import type { Id } from '@trioditis/backend/dataModel'
import {
  contactKey,
  parseIdentifier,
  START_TARGETS,
  startIdentifier,
  type StartIdentifierProblem,
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
import { accountLabels } from '~/data/account-label.ts'
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
  /** What tells it apart from the person's other accounts on the network, if they have more (account-label.ts). */
  detail?: string | null
}

/** The person's connected accounts that can start chats, in the order they connected. */
export function useStartableAccounts(): StartableAccount[] {
  const accounts = useAccounts()
  // Labelled among all their accounts, so one is called the same here as in Settings.
  const labels = accountLabels((accounts ?? []).map((a) => ({ id: a._id, network: a.network, hint: a.hint })))
  return (accounts ?? []).flatMap((a) =>
    a.state === 'CONNECTED' && START_TARGETS[a.network]
      ? [{ networkAccountId: a._id, network: a.network, detail: labels.get(a._id)?.detail ?? null }]
      : [],
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

/**
 * What the New chat dialog offers: the networks that can start from a number or username, the
 * one in use (the person's pick, else the first), its accounts, and the account the chat
 * starts from. With more than one account on the network that's only the one the person
 * picked: the app doesn't guess which of their logins a new contact should see them on.
 */
export function newChatChoice(
  startable: readonly StartableAccount[],
  chosenNetwork: Network | undefined,
  chosenAccount: Id<'networkAccounts'> | undefined,
) {
  const usable = startable.filter((a) => identifierPrompt(a.network))
  const networks = [...new Set(usable.map((a) => a.network))]
  const network = chosenNetwork && networks.includes(chosenNetwork) ? chosenNetwork : networks[0]
  const accounts = usable.filter((a) => a.network === network)
  const account = accounts.length === 1 ? accounts[0] : accounts.find((a) => a.networkAccountId === chosenAccount)
  return { networks, network, accounts, account }
}

/** What to tell the person when a chat couldn't start. */
export function startError(code: ErrorCode | undefined, network: Network): string {
  const name = networkName(network)
  // The number was sent in full and in the form the network takes (startIdentifier), so this
  // is the network's own answer; it can still be a number saved without its country code.
  if (code === 'not_found')
    return `${name} found no one with that number or username. Check it’s complete, with the country code.`
  if (code === 'invalid_identifier')
    return `That isn’t a number or username ${name} takes. Check it, with the country code.`
  if (code === 'unsupported') return `${name} can’t start chats from here.`
  if (code === 'not_connected') return `Your ${name} account isn’t connected.`
  if (code === 'rate_limited') return `${name} is limiting new chats. Try again later.`
  if (code === 'expired' || code === 'timeout') return `${name} didn’t answer. Try again.`
  return `${name} couldn’t start that chat.`
}

/** What to tell the person when what they typed can't start a chat, before it's sent. */
export function identifierProblem(problem: StartIdentifierProblem, network: Network): string {
  const name = networkName(network)
  if (problem === 'needs_country_code') return `${name} needs the number with its country code, like +1 555 123 4567.`
  if (problem === 'phone_only') return `${name} starts chats from phone numbers, not usernames.`
  if (problem === 'username_only') return `${name} starts chats from usernames, not phone numbers.`
  return 'That isn’t a whole phone number. Check it has all its digits.'
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
        // Sent in one shape the bridge host takes (people.ts, normalPhone), or not at all.
        const targets = START_TARGETS[network] ?? { phone: false, username: false }
        const typed = startIdentifier(target.identifier, network, targets)
        if ('problem' in typed) return setError(identifierProblem(typed.problem, network))
        if (!bridge.key) return setError('Trioditis isn’t ready to start chats yet. Try again in a moment.')
        const sealedIdentifier = sealJson(
          { identifier: typed.identifier },
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
 * (START_TARGETS): its linked contacts first, on each account there, those that sent them
 * first (the chat they already have, or a new one), then its numbers on networks that find
 * people by number, and its usernames on their own network, on each account a linked contact
 * doesn't cover. A number or username goes as written; the bridge host puts it in the form
 * the network takes.
 */
export function chatOptions(
  card: PersonPlaintext,
  accounts: readonly StartableAccount[],
  byContact: ReadonlyMap<string, NetworkContact>,
): ChatOption[] {
  const out: ChatOption[] = []
  const onNetwork = (network: Network) => accounts.filter((a) => a.network === network)
  // An account is called what Settings calls it (account-label.ts); without that, "account 2"
  // is the same account everywhere: numbered in the order the person connected them.
  const named = (label: string, network: Network, account: StartableAccount) => {
    const all = onNetwork(network)
    if (all.length < 2) return label
    return `${label} (${account.detail || `account ${all.indexOf(account) + 1}`})`
  }
  // Accounts a linked contact came from, where starting from the contact works for sure.
  const covered = new Set<string>()
  for (const link of card.links ?? []) {
    if (!START_TARGETS[link.network]?.contact) continue
    const contact = byContact.get(contactKey(link))
    const label = contact?.profile.name || 'Contact'
    // On every account the person has on that network, the ones that sent the contact first:
    // some networks' contact IDs belong to one login, so with more than one account the person
    // chooses, rather than the app guessing and failing quietly.
    const sent = new Set(contact?.networkAccountIds ?? [])
    const ordered = [...onNetwork(link.network)].sort(
      (x, y) => Number(sent.has(y.networkAccountId)) - Number(sent.has(x.networkAccountId)),
    )
    for (const account of ordered) {
      if (sent.has(account.networkAccountId)) covered.add(account.networkAccountId)
      out.push({
        network: link.network,
        networkAccountId: account.networkAccountId,
        label: named(label, link.network, account),
        target: { ghostId: link.ghostId },
      })
    }
  }
  // A number or username works from any account, so it's offered on each one a linked contact
  // doesn't already cover.
  const add = (network: Network, label: string, identifier: string) => {
    for (const account of onNetwork(network)) {
      if (covered.has(account.networkAccountId)) continue
      out.push({
        network,
        networkAccountId: account.networkAccountId,
        label: named(label, network, account),
        target: { identifier },
      })
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
