import { networkName } from '~/data/chats.ts'

// What an account is called in the app. The network's name is enough while the person has one
// account on it; with more, each also shows what tells it apart (`hint` from logins.accounts:
// its phone number, or the end of its ID), so a disconnect or a new chat names the right one.

export interface AccountLabel {
  /** The network's name. */
  name: string
  /** What tells it apart from the person's other accounts on the network, or null with only one. */
  detail: string | null
  /** Both together, for a sentence: `WhatsApp (+15550100)`. */
  full: string
}

interface Labelled<Id extends string> {
  id: Id
  network: string
  hint?: string
}

/**
 * Labels for the person's accounts, by ID. Accounts are counted per network across the whole
 * list, in its order (the order they connected), so `Account 2` is the same one everywhere
 * when there's no hint to show.
 */
export function accountLabels<Id extends string>(accounts: readonly Labelled<Id>[]): Map<Id, AccountLabel> {
  const byNetwork = new Map<string, Labelled<Id>[]>()
  for (const account of accounts) byNetwork.set(account.network, [...(byNetwork.get(account.network) ?? []), account])
  const labels = new Map<Id, AccountLabel>()
  for (const [network, same] of byNetwork) {
    const name = networkName(network)
    same.forEach((account, i) => {
      // Two IDs can end the same way; the count keeps them apart then.
      const shared = same.some((other) => other !== account && other.hint === account.hint)
      const detail =
        same.length < 2
          ? null
          : !account.hint
            ? `Account ${i + 1}`
            : shared
              ? `${account.hint}, account ${i + 1}`
              : account.hint
      labels.set(account.id, { name, detail, full: detail ? `${name} (${detail})` : name })
    })
  }
  return labels
}
