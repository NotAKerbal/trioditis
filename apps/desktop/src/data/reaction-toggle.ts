// The person's own reactions show as soon as they're chosen, before the bridge host's echo:
// a reaction added or taken away here is laid over the server's answer until the answer says
// the same, or for CONFIRM_MS at most. Nothing is sent again after that (client-api.md, Sending).

/** One reaction on a message, with how many gave it: `more` when there may be others unseen. */
export interface Reaction {
  key: string
  count: number
  more: boolean
  mine: boolean
}

/** A reaction the person just added (or, with `remove`, took away), not yet echoed. */
export interface PendingReaction {
  messageId: string
  key: string
  remove: boolean
  at: number
}

/** How long a reaction shows as chosen while the network hasn't confirmed it. */
export const CONFIRM_MS = 30_000

/**
 * Whether two keys are the same reaction. The bridge host stores keys without variation
 * selectors (bridge-protocol.md, `reaction`), while a picked emoji may have one.
 */
export const sameKey = (a: string, b: string) => a.replaceAll('\uFE0F', '') === b.replaceAll('\uFE0F', '')

/**
 * A key as shown: a lone emoji that would otherwise draw as a plain symbol (❤, ☺) gets its
 * emoji variation selector back, since the stored key has none.
 */
export const shownKey = (key: string) =>
  /^\p{Emoji}$/u.test(key) && !/\p{Emoji_Presentation}/u.test(key) ? `${key}\uFE0F` : key

/** Whether the server's reactions already say what `p` asked for. */
export function confirmed(p: PendingReaction, server: ReadonlyMap<string, readonly Reaction[]>): boolean {
  const mine = !!server.get(p.messageId)?.some((r) => r.mine && sameKey(r.key, p.key))
  return p.remove ? !mine : mine
}

/** The server's reactions with the pending ones laid over them. */
export function withPending(
  server: ReadonlyMap<string, readonly Reaction[]>,
  pending: readonly PendingReaction[],
): Map<string, Reaction[]> {
  const out = new Map([...server].map(([id, list]) => [id, list.map((r) => ({ ...r }))]))
  for (const p of pending) {
    const list = out.get(p.messageId) ?? []
    const i = list.findIndex((r) => sameKey(r.key, p.key))
    const r = list[i]
    if (p.remove) {
      if (!r?.mine) continue
      if (r.count > 1) list[i] = { ...r, count: r.count - 1, mine: false }
      else list.splice(i, 1)
    } else if (!r) list.push({ key: p.key, count: 1, more: false, mine: true })
    else if (!r.mine) list[i] = { ...r, count: r.count + 1, mine: true }
    out.set(p.messageId, list)
  }
  return out
}
