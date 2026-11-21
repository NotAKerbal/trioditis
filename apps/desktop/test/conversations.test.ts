import type { ChatRow, Network, Person } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import { mergedChat, type Chat, type ChatId } from '../src/data/chats.ts'
import {
  cardIndex,
  MAX_MERGED,
  mergeDms,
  requestSendOn,
  stableSlots,
  takeSendRequest,
} from '../src/data/conversations.ts'
import { horizonOf, mergePages } from '../src/data/messages.ts'

let n = 0
function chat(network: Network, dmGhostId: string | undefined, over: Partial<ChatRow> = {}, at = 0): Chat {
  const id = `chat${++n}` as ChatId
  const row = {
    _id: id,
    kind: 'dm',
    network,
    pinned: false,
    markedUnread: false,
    unreadCount: 0,
    mentionCount: 0,
    labelIds: [],
    lastMessageAt: at,
    ...over,
  } as unknown as ChatRow
  return {
    id,
    row,
    network,
    name: `Chat on ${network}`,
    named: false,
    topic: undefined,
    avatar: undefined,
    described: true,
    unread: row.unreadCount,
    hasUnread: row.unreadCount > 0,
    mentions: 0,
    muted: false,
    last: at ? { at, text: `at ${at}` } : null,
    dmGhostId,
  } as Chat
}

const alice = {
  personKey: 'alice-card-0000000001',
  card: {
    name: 'Alice Moreno',
    links: [
      { network: 'whatsapp', ghostId: 'g_wa_alice' },
      { network: 'signal', ghostId: 'g_sig_alice' },
    ],
  },
} satisfies Person

describe('a person’s direct chats on several networks', () => {
  it('are one conversation once a card links their contacts, in the place of the first', () => {
    const wa = chat('whatsapp', 'g_wa_alice')
    const bob = chat('whatsapp', 'g_wa_bob')
    const sig = chat('signal', 'g_sig_alice')
    const groups = mergeDms([wa, bob, sig], cardIndex([alice]))
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([[wa.id, sig.id], [bob.id]])
    expect(groups[0]!.person?.name).toBe('Alice Moreno')
    expect(groups[1]!.person).toBeUndefined()
  })

  it('stay apart without a card, without knowing who a chat is with, and in a group', () => {
    const wa = chat('whatsapp', 'g_wa_alice')
    const old = chat('signal', undefined)
    const group = chat('signal', 'g_sig_alice', { kind: 'group' })
    expect(mergeDms([wa, old, group], cardIndex([alice])).every((g) => g.members.length === 1)).toBe(true)
    expect(mergeDms([wa, chat('signal', 'g_sig_alice')], cardIndex([])).length).toBe(2)
  })

  it('hold at most MAX_MERGED chats; the rest stay rows of their own', () => {
    const links = Array.from({ length: MAX_MERGED + 2 }, (_, i) => ({ network: 'whatsapp' as const, ghostId: `g${i}` }))
    const card = { personKey: 'many-chats-000000001', card: { name: 'Many', links } }
    const chats = links.map((l) => chat('whatsapp', l.ghostId))
    const groups = mergeDms(chats, cardIndex([card]))
    expect(groups[0]!.members.length).toBe(MAX_MERGED)
    expect(groups.length).toBe(3)
  })

  it('sum up as one row: unread if any is, muted only if all are, the newest message of any', () => {
    const wa = chat('whatsapp', 'g_wa_alice', { unreadCount: 2, labelIds: ['l1'] } as Partial<ChatRow>, 100)
    const sig = chat(
      'signal',
      'g_sig_alice',
      { unreadCount: 1, pinned: true, labelIds: ['l2'] } as Partial<ChatRow>,
      300,
    )
    sig.muted = true
    const row = mergedChat([wa, sig], { personKey: alice.personKey, name: 'Alice Moreno', photo: undefined })
    expect(row.id).toBe(wa.id)
    expect(row.name).toBe('Alice Moreno')
    expect(row.unread).toBe(3)
    expect(row.row.pinned).toBe(true)
    expect(row.muted).toBe(false)
    expect(row.last?.at).toBe(300)
    expect(row.row.labelIds).toEqual(['l1', 'l2'])
    expect(row.members?.map((m) => m.id)).toEqual([wa.id, sig.id])
  })
})

describe('a conversation’s messages, each chat paged on its own', () => {
  const m = (chatId: string, at: number) => ({ chatId, at })

  it('are merged by time, each chat keeping its own order', () => {
    const a = { messages: [m('a', 1), m('a', 4), m('a', 6)], more: false }
    const b = { messages: [m('b', 2), m('b', 3), m('b', 7)], more: false }
    expect(mergePages([a, b]).map((x) => `${x.chatId}${x.at}`)).toEqual(['a1', 'b2', 'b3', 'a4', 'a6', 'b7'])
  })

  it('go back only as far as every chat with more to load has loaded', () => {
    // b has more before 5: a's older messages wait until b's from then have loaded too.
    const a = { messages: [m('a', 1), m('a', 4), m('a', 6)], more: false }
    const b = { messages: [m('b', 5), m('b', 7)], more: true }
    expect(mergePages([a, b]).map((x) => `${x.chatId}${x.at}`)).toEqual(['b5', 'a6', 'b7'])
  })

  it('of one chat are its messages as they are', () => {
    const a = { messages: [m('a', 3), m('a', 1)], more: true }
    expect(mergePages([a])).toEqual(a.messages)
  })
})

describe('a conversation’s page slots', () => {
  it('keep each chat in its slot as the order changes, so its loaded pages stay', () => {
    const first = stableSlots([], ['a', 'b'])
    expect(first.slice(0, 2)).toEqual(['a', 'b'])
    // A new message in b puts it first; neither moves.
    expect(stableSlots(first, ['b', 'a'])).toEqual(first)
    // a leaves, freeing its slot, and c joins in it; b stays where it was.
    expect(stableSlots(first, ['c', 'b']).slice(0, 3)).toEqual(['c', 'b', undefined])
    expect(stableSlots([], ['x'])).toHaveLength(MAX_MERGED)
  })
})

describe('what a conversation shows of a quieter chat', () => {
  it('is nothing until the others have loaded back to its messages', () => {
    const busy = { messages: [{ at: 50 }, { at: 60 }], more: true }
    const quiet = { messages: [{ at: 10 }, { at: 20 }], more: false }
    // Every message of the quiet chat is from before what's shown, so it isn't marked read yet.
    expect(horizonOf([busy, quiet])).toBe(50)
    expect(quiet.messages.at(-1)!.at < horizonOf([busy, quiet])).toBe(true)
    expect(horizonOf([quiet])).toBe(-Infinity)
  })
})

describe('a chat chosen to send on from a profile', () => {
  it('is taken once, by a conversation it’s in', () => {
    requestSendOn('signal-chat')
    expect(takeSendRequest(['whatsapp-chat'])).toBeNull()
    expect(takeSendRequest(['whatsapp-chat', 'signal-chat'])).toBe('signal-chat')
    expect(takeSendRequest(['whatsapp-chat', 'signal-chat'])).toBeNull()
  })
})
