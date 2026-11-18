// messages.reactions takes at most 100 IDs and reads at most 8 MiB of reactions, going through
// the IDs in order. If that runs out, the IDs it didn't reach are left out of the answer, and
// asking again for those gets them, so a missing ID doesn't mean "no reactions". A deleted
// message is left out too; the first ID asked about is always reached, so missing there, it
// was deleted. See docs/architecture/client-api.md, Messages.

export const MAX_IDS_PER_REQUEST = 100

/** The IDs an answer didn't reach, in order: everything from the first one missing after the first. */
export function unreached<T extends string>(asked: readonly T[], answer: Record<string, unknown>): T[] {
  const cut = asked.findIndex((id, i) => i > 0 && !Object.hasOwn(answer, id))
  return cut < 0 ? [] : asked.slice(cut)
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The loaded messages (oldest first) in groups whose edges stay put as the list grows: by day
 * (UTC), then runs of at most 100 from each day's oldest message. Loading earlier history only
 * changes the oldest, partly loaded day's groups, and a message arriving in order (newest) only
 * the newest day's last one, so the other groups keep their requests, answers and subscriptions.
 * Pending copies aren't passed in: they have no reactions yet, and their place can still move.
 */
export function reactionGroups<T extends string>(messages: readonly { id: T; at: number }[]): T[][] {
  const groups: T[][] = []
  let day: number | null = null
  for (const m of messages) {
    const d = Math.floor(m.at / DAY_MS)
    const last = groups.at(-1)
    if (last && d === day && last.length < MAX_IDS_PER_REQUEST) last.push(m.id)
    else groups.push([m.id])
    day = d
  }
  return groups
}

/**
 * The requests that cover `ids`: up to 100 at a time, each asking first for what the one before
 * it didn't reach. `answerFor` gives a request's answer once it has come; the plan stops at the
 * first request still waiting, and grows as answers come. Every request after the first starts
 * past at least one ID, so there are never more requests than IDs, and none is left out.
 */
export function reactionRequests<T extends string>(
  ids: readonly T[],
  answerFor: (asked: T[]) => Record<string, unknown> | undefined,
): T[][] {
  const requests: T[][] = []
  let rest = [...ids]
  while (rest.length > 0) {
    const asked = rest.slice(0, MAX_IDS_PER_REQUEST)
    requests.push(asked)
    const answer = answerFor(asked)
    if (!answer) break
    rest = [...unreached(asked, answer), ...rest.slice(MAX_IDS_PER_REQUEST)]
  }
  return requests
}

/** How long a message may keep its last reactions while a new request for them is on its way. */
export const KEEP_SHOWN_MS = 5000

export interface Shown<L> {
  list: L
  /** When an answer last gave this list. */
  at: number
}

/**
 * What each of `ids` shows: its answer, when one is in. Otherwise, only while the request for it
 * is still on its way (`waiting`) and for at most KEEP_SHOWN_MS since an answer last gave it, the
 * list it showed before, so moving a group to a new request doesn't blank it. A failed request,
 * or one that takes longer, shows nothing rather than reactions that may since have gone.
 * `expires` is when the next kept list runs out, to look again then.
 */
export function showReactions<L>(
  ids: readonly string[],
  fresh: Readonly<Record<string, L>>,
  waiting: ReadonlySet<string>,
  before: ReadonlyMap<string, Shown<L>>,
  now: number,
): { shown: Map<string, Shown<L>>; expires: number | null } {
  const shown = new Map<string, Shown<L>>()
  let expires: number | null = null
  for (const id of ids) {
    if (Object.hasOwn(fresh, id)) {
      shown.set(id, { list: fresh[id]!, at: now })
      continue
    }
    const kept = before.get(id)
    if (!kept || !waiting.has(id) || now - kept.at >= KEEP_SHOWN_MS) continue
    shown.set(id, kept)
    expires = Math.min(expires ?? Infinity, kept.at + KEEP_SHOWN_MS)
  }
  return { shown, expires }
}
