import { describe, expect, it } from 'vitest'
import { MAX_IDS_PER_REQUEST, reactionGroups, reactionRequests, unreached } from '../src/data/reaction-requests.ts'

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `m${from + i}`)
/** An answer covering `reached`, as the server gives one: each reached ID, with its reactions or none. */
const answer = (reached: string[], deleted: string[] = []) =>
  Object.fromEntries(reached.filter((id) => !deleted.includes(id)).map((id) => [id, []]))

describe('asking for reactions until every message is covered', () => {
  it('asks once when the answer covers everything', () => {
    const asked = ids(5)
    expect(reactionRequests(asked, () => answer(asked))).toEqual([asked])
  })

  it('asks again for the IDs a partial answer left out, instead of taking them as none', () => {
    const asked = ids(5)
    // The server's read limit ran out after m0 and m1.
    const answers = new Map([[asked.join(), answer(['m0', 'm1'])]])
    const requests = reactionRequests(asked, (a) => answers.get(a.join()))
    expect(requests).toEqual([asked, ['m2', 'm3', 'm4']])
    // Once that answer comes, nothing is left to ask.
    answers.set('m2,m3,m4', answer(['m2', 'm3', 'm4']))
    expect(reactionRequests(asked, (a) => answers.get(a.join()))).toEqual([asked, ['m2', 'm3', 'm4']])
  })

  it('waits at the first request without an answer', () => {
    expect(reactionRequests(ids(5), () => undefined)).toEqual([ids(5)])
  })

  it('asks at most 100 at a time', () => {
    const all = ids(250)
    const requests = reactionRequests(all, (a) => answer(a))
    expect(requests.map((r) => r.length)).toEqual([MAX_IDS_PER_REQUEST, MAX_IDS_PER_REQUEST, 50])
    expect(requests.flat()).toEqual(all)
  })

  it('carries what a partial answer missed into the next request', () => {
    const all = ids(150)
    const first = all.slice(0, 100)
    const answers = new Map([[first.join(), answer(first.slice(0, 60))]])
    const requests = reactionRequests(all, (a) => answers.get(a.join()))
    expect(requests[1]).toEqual([...first.slice(60), ...all.slice(100)])
  })

  it('gets past a deleted message the answer leaves out', () => {
    const asked = ids(4)
    // m1 was deleted: the answer leaves it out, which looks like a cut there, so it's asked again,
    // first. Missing as the first ID asked about, it was deleted, and the plan moves on.
    const answers = new Map([
      [asked.join(), answer(asked, ['m1'])],
      ['m1,m2,m3', answer(['m1', 'm2', 'm3'], ['m1'])],
    ])
    expect(reactionRequests(asked, (a) => answers.get(a.join()))).toEqual([asked, ['m1', 'm2', 'm3']])
  })

  it('never re-asks the first ID: missing there, it was deleted', () => {
    expect(unreached(['m0', 'm1'], answer(['m1']))).toEqual([])
    expect(unreached(['m0', 'm1', 'm2'], answer(['m0']))).toEqual(['m1', 'm2'])
    expect(unreached(['m0', 'm1'], answer(['m0', 'm1']))).toEqual([])
  })

  it('ends even when every answer covers only its first ID, asking no more often than there are IDs', () => {
    const all = ids(500)
    const requests = reactionRequests(all, (a) => answer(a.slice(0, 1)))
    expect(requests.length).toBeLessThanOrEqual(all.length)
    expect(new Set(requests.map((r) => r[0]))).toEqual(new Set(all))
  })
})

describe('grouping messages so requests stay put as the list grows', () => {
  const DAY = 24 * 60 * 60 * 1000
  // `n` messages a day for `days` days, oldest first, a minute apart.
  const loaded = (days: number, n: number, firstDay = 0) =>
    Array.from({ length: days * n }, (_, i) => {
      const day = firstDay + Math.floor(i / n)
      return { id: `d${day}-${i % n}`, at: day * DAY + (i % n) * 60_000 }
    })

  it('groups by day, at most 100 a group', () => {
    const groups = reactionGroups(loaded(2, 150))
    expect(groups.map((g) => g.length)).toEqual([100, 50, 100, 50])
    expect(groups[2]![0]).toBe('d1-0')
  })

  it('keeps the newer days’ groups when earlier history loads', () => {
    const now = reactionGroups(loaded(3, 30, 5))
    const more = reactionGroups([...loaded(2, 30, 3), ...loaded(3, 30, 5)])
    expect(more.slice(-now.length)).toEqual(now)
  })

  it('changes only the newest group when a message arrives', () => {
    const before = loaded(3, 30)
    const now = reactionGroups(before)
    const after = reactionGroups([...before, { id: 'new', at: 2 * DAY + 50 * 60_000 }])
    expect(after.slice(0, -1)).toEqual(now.slice(0, -1))
    expect(after.at(-1)).toEqual([...now.at(-1)!, 'new'])
  })

  it('covers every loaded message, however many', () => {
    const all = loaded(51, 100)
    expect(all).toHaveLength(5100)
    const requests = reactionGroups(all).flatMap((g) => reactionRequests(g, (a) => answer(a)))
    expect(requests.flat()).toEqual(all.map((m) => m.id))
  })
})
