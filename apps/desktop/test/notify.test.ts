import type { Arrival, ArrivalFeed, ChatRow, LastMessage } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import type { Chat } from '../src/data/chats.ts'
import { LATE_MS, newArrivals, notificationText, type Cursor } from '../src/data/notify.ts'

const arrival = (messageId: string, arrivedAt: number): Arrival => ({
  arrivedAt,
  message: { messageId, at: 1, self: false, redacted: false, sealed: null, objectId: messageId } as LastMessage,
  chat: { _id: 'c1' } as ChatRow,
})
const feed = (latest: number | null, ...arrivals: Arrival[]): ArrivalFeed => ({ latest, arrivals })

const ids = (arrivals: Arrival[]) => arrivals.map((a) => a.message.messageId)

describe('which arrivals notify', () => {
  // Each answer is a feed, or a feed and when (this device's clock) it came; 0 by default.
  const after = (cursor: Cursor | undefined, ...answers: (ArrivalFeed | [ArrivalFeed, number])[]) => {
    const fresh: string[][] = []
    for (const answer of answers) {
      const [f, now] = Array.isArray(answer) ? answer : [answer, 0]
      const next = newArrivals(cursor, f, now)
      cursor = next.cursor
      fresh.push(ids(next.fresh))
    }
    return { cursor: cursor!, fresh }
  }
  const at = (since: number) => after(undefined, feed(since)).cursor

  it('only sets the cursor on the first answer', () => {
    const first = newArrivals(undefined, feed(20, arrival('m2', 20), arrival('m1', 10)), 0)
    expect(first.fresh).toEqual([])
    expect(first.cursor.since).toBe(20)
    // Nothing has arrived yet: everything after counts.
    expect(newArrivals(undefined, feed(null), 0).cursor.since).toBe(0)
  })

  it('notifies for what arrived after the cursor, once', () => {
    const { fresh, cursor } = after(
      at(10),
      feed(30, arrival('m3', 30), arrival('m2', 20)),
      feed(30, arrival('m3', 30), arrival('m2', 20)),
    )
    expect(fresh).toEqual([['m3', 'm2'], []])
    expect(cursor.since).toBe(30)
  })

  it('never announces what was there on the first answer, even when it comes again', () => {
    expect(after(undefined, feed(20, arrival('m1', 20)), feed(25, arrival('m1', 20))).fresh).toEqual([[], []])
  })

  it('still notifies for a message that committed after a newer one', () => {
    // m1's mutation started first but committed after m2: it arrives with an earlier time.
    const start = at(100_000)
    const { fresh } = after(
      start,
      feed(100_200, arrival('m2', 100_200)),
      feed(100_200, arrival('m2', 100_200), arrival('m1', 100_100)),
    )
    expect(fresh).toEqual([['m2'], ['m1']])
  })

  it('stays quiet for an old message that comes into view later', () => {
    // Its chat brought back from the archive: it arrived long before the cursor.
    expect(after(at(LATE_MS * 3), feed(LATE_MS * 3, arrival('old', 5))).fresh).toEqual([[]])
    // Or just before it, but the chat comes back long after the cursor last moved.
    const days = 3 * 24 * 3600_000
    expect(after(at(100_000), [feed(100_000, arrival('archived', 99_000)), days]).fresh).toEqual([[]])
    // Or right after the app opened, when the cursor hasn't moved since.
    expect(after(at(100_000), [feed(100_000, arrival('archived', 99_000)), 1_000]).fresh).toEqual([[]])
  })

  it('moves the cursor past the person’s own sends, which aren’t listed', () => {
    const { cursor } = after(at(30), feed(40))
    expect(cursor.since).toBe(40)
    expect(after(cursor, feed(50, arrival('m4', 50))).fresh).toEqual([['m4']])
  })

  it('forgets what it has seen once it is too old to come again', () => {
    const { cursor } = after(at(0), feed(10, arrival('m1', 10)), feed(LATE_MS * 2))
    expect([...cursor.seen.keys()]).toEqual([])
  })
})

describe('what a notification says', () => {
  const chat = { id: 'c1', name: 'Alice', network: 'whatsapp' } as Chat
  it('shows only the network unless the person chooses more', () => {
    expect(notificationText(chat, 'See you at 7', 'network')).toEqual({ title: 'New message', body: 'On WhatsApp' })
    expect(notificationText(chat, 'See you at 7', 'name')).toEqual({ title: 'Alice', body: 'New message' })
    expect(notificationText(chat, 'See you at 7', 'message')).toEqual({ title: 'Alice', body: 'See you at 7' })
    expect(notificationText(chat, null, 'message').body).toBe('New message')
  })
})
