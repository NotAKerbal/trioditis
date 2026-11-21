import { api } from '@trioditis/backend/api'
import type { ContactPlaintext, Network } from '@trioditis/core'
import type { Envelope } from '@trioditis/crypto'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { avatarOf } from '~/data/chats.ts'
import { openCached } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

/** The most ghost IDs one `contacts.get` takes. */
const MAX_IDS_PER_REQUEST = 100

// Opened profiles (openCached), so re-renders don't decrypt every sender again.
const profileCache = new Map<string, ContactPlaintext | null>()

type Answer = { ghostId: string; sealedProfile: Envelope }[]
// Outside the hook, so useQueries can keep its result while the answers don't change.
const dataOf = (results: { data?: Answer | undefined; isPending: boolean }[]) => ({
  answers: results.map((r) => r.data),
  pending: results.some((r) => r.isPending),
})

/**
 * The profiles of these senders on a network, by ghost ID, opened here. Asked for in sorted runs
 * of 100, so the order messages load in doesn't change the requests; most chats have fewer
 * senders than that, so one request. A sender with no contact, or one this device can't open,
 * is missing.
 */
export function useContacts(network: Network, ghostIds: readonly string[]): Map<string, ContactPlaintext> {
  return useContactProfiles(network, ghostIds).profiles
}

/** `useContacts`, and whether any of them is still on its way. */
export function useContactProfiles(
  network: Network,
  ghostIds: readonly string[],
): { profiles: Map<string, ContactPlaintext>; pending: boolean } {
  const session = useSession()
  const sorted = [...new Set(ghostIds)].sort()
  const runs: string[][] = []
  for (let i = 0; i < sorted.length; i += MAX_IDS_PER_REQUEST) runs.push(sorted.slice(i, i + MAX_IDS_PER_REQUEST))
  const { answers, pending } = useQueries({
    queries: runs.map((ids) => convexQuery(api.contacts.get, { network, ghostIds: ids })),
    combine: dataOf,
  })
  const profiles = useMemo(() => {
    const out = new Map<string, ContactPlaintext>()
    for (const answer of answers) {
      for (const { ghostId, sealedProfile } of answer ?? []) {
        const profile = openCached<ContactPlaintext>(
          profileCache,
          sealedProfile,
          session.keyPair,
          session.kid,
          'contact',
          session.userId,
          ghostId,
        )
        if (!profile) continue
        const avatar = avatarOf(`${session.userId}/${network}/${ghostId}`, profile)
        out.set(ghostId, avatar === profile.avatar ? profile : { ...profile, avatar })
      }
    }
    return out
  }, [answers, session, network])
  return { profiles, pending }
}

/**
 * Profiles of contacts on any networks, by `network/ghostId`: `useContacts` for each network, in
 * one set of requests.
 */
export function useContactsAcross(contacts: readonly { network: Network; ghostId: string }[]) {
  const session = useSession()
  const byNetwork = new Map<Network, string[]>()
  for (const c of contacts) byNetwork.set(c.network, [...(byNetwork.get(c.network) ?? []), c.ghostId])
  const asked = [...byNetwork]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([network, ids]) => {
      const sorted = [...new Set(ids)].sort()
      const runs: { network: Network; ghostIds: string[] }[] = []
      for (let i = 0; i < sorted.length; i += MAX_IDS_PER_REQUEST)
        runs.push({ network, ghostIds: sorted.slice(i, i + MAX_IDS_PER_REQUEST) })
      return runs
    })
  const { answers } = useQueries({
    queries: asked.map((args) => convexQuery(api.contacts.get, args)),
    combine: dataOf,
  })
  const networks = asked.map((a) => a.network).join()
  return useMemo(() => {
    const out = new Map<string, ContactPlaintext>()
    answers.forEach((answer, i) => {
      const network = networks.split(',')[i] as Network
      for (const { ghostId, sealedProfile } of answer ?? []) {
        const profile = openCached<ContactPlaintext>(
          profileCache,
          sealedProfile,
          session.keyPair,
          session.kid,
          'contact',
          session.userId,
          ghostId,
        )
        if (profile) out.set(`${network}/${ghostId}`, profile)
      }
    })
    return out
  }, [answers, networks, session])
}
