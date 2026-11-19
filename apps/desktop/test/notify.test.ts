import type { Arrival, ArrivalFeed, ChatRow, LastMessage } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import type { Chat } from '../src/data/chats.ts'
import { newArrivals, notificationText } from '../src/data/notify.ts'

const arrival = (messageId: string, arrivedAt: number): Arrival => ({
  arrivedAt,
  message: { messageId, at: 1, self: false, redacted: false, sealed: null, objectId: messageId } as LastMessage,
  chat: { _id: 'c1' } as ChatRow,
})
const feed = (latest: number | null, ...arrivals: Arrival[]): ArrivalFeed => ({ latest, arrivals })

const ids = (arrivals: Arrival[]) => arrivals.map((a) => a.message.messageId)

describe('which arrivals notify', () => {
  it('only sets the cursor on the first answer', () => {
    expect(newArrivals(undefined, feed(20, arrival('m2', 20), arrival('m1', 10)))).toEqual({ since: 20, fresh: [] })
    // Nothing has arrived yet: everything after counts.
    expect(newArrivals(undefined, feed(null))).toEqual({ since: 0, fresh: [] })
  })

  it('notifies for what arrived after the cursor, once', () => {
    const second = newArrivals(10, feed(30, arrival('m3', 30), arrival('m2', 20), arrival('m1', 10)))
    expect(ids(second.fresh)).toEqual(['m3', 'm2'])
    expect(second.since).toBe(30)
    expect(newArrivals(second.since, feed(30, arrival('m3', 30), arrival('m2', 20))).fresh).toEqual([])
  })

  it('stays quiet for an old message that comes into view later', () => {
    // Its chat brought back from the archive: it arrived before the cursor.
    expect(newArrivals(30, feed(30, arrival('old', 5))).fresh).toEqual([])
  })

  it('moves the cursor past the person’s own sends, which aren’t listed', () => {
    const { since } = newArrivals(30, feed(40))
    expect(since).toBe(40)
    expect(newArrivals(since, feed(50, arrival('m4', 50))).fresh.length).toBe(1)
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
