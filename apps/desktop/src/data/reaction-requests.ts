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

/**
 * The requests that cover `ids`: up to 100 at a time, each asking first for what the one before
 * it didn't reach. `answerFor` gives a request's answer once it has come; the plan stops at the
 * first request still waiting, and grows as answers come. Every request after the first starts
 * past at least one ID, so the plan always ends; `limit` caps it anyway.
 */
export function reactionRequests<T extends string>(
  ids: readonly T[],
  answerFor: (asked: T[]) => Record<string, unknown> | undefined,
  limit = 50,
): T[][] {
  const requests: T[][] = []
  let rest = [...ids]
  while (rest.length > 0 && requests.length < limit) {
    const asked = rest.slice(0, MAX_IDS_PER_REQUEST)
    requests.push(asked)
    const answer = answerFor(asked)
    if (!answer) break
    rest = [...unreached(asked, answer), ...rest.slice(MAX_IDS_PER_REQUEST)]
  }
  return requests
}
