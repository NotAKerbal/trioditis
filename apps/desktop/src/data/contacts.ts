import { api } from '@trioditis/backend/api'
import type { ContactPlaintext, Network } from '@trioditis/core'
import type { Envelope } from '@trioditis/crypto'
import { convexQuery } from '@convex-dev/react-query'
import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { openCached } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'

/** The most ghost IDs one `contacts.get` takes. */
const MAX_IDS_PER_REQUEST = 100

// Opened profiles (openCached), so re-renders don't decrypt every sender again.
const profileCache = new Map<string, ContactPlaintext | null>()

type Answer = { ghostId: string; sealedProfile: Envelope }[]
// Outside the hook, so useQueries can keep its result while the answers don't change.
const dataOf = (results: { data?: Answer | undefined }[]) => results.map((r) => r.data)

/**
 * The profiles of these senders on a network, by ghost ID, opened here. Asked for in sorted runs
 * of 100, so the order messages load in doesn't change the requests; most chats have fewer
 * senders than that, so one request. A sender with no contact, or one this device can't open,
 * is missing.
 */
export function useContacts(network: Network, ghostIds: readonly string[]): Map<string, ContactPlaintext> {
  const session = useSession()
  const sorted = [...new Set(ghostIds)].sort()
  const runs: string[][] = []
  for (let i = 0; i < sorted.length; i += MAX_IDS_PER_REQUEST) runs.push(sorted.slice(i, i + MAX_IDS_PER_REQUEST))
  const answers = useQueries({
    queries: runs.map((ids) => convexQuery(api.contacts.get, { network, ghostIds: ids })),
    combine: dataOf,
  })
  return useMemo(() => {
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
        if (profile) out.set(ghostId, profile)
      }
    }
    return out
  }, [answers, session])
}
