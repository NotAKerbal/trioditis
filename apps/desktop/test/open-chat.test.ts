import type { ChatRow } from '@trioditis/core'
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { openChatRow } from '../src/data/chats.ts'

const known = { _id: 'chat1', network: 'signal' } as unknown as ChatRow
const fresh = { _id: 'chat1', network: 'signal', unreadCount: 2 } as unknown as ChatRow
const timeout = new Error('[CONVEX Q(chats:get)] [Request ID: 1] Server Error')

describe('the chat the person clicked', () => {
  it('stays open on the sidebar’s copy when its first answer times out', () => {
    // The bug: a timeout before any answer counted as the chat being gone, and it closed.
    expect(openChatRow(undefined, timeout, known)).toEqual({ row: known, confirmed: false, gone: false })
  })

  it('stays open as loading when a timeout comes with nothing known of it', () => {
    expect(openChatRow(undefined, timeout, undefined)).toEqual({ row: undefined, confirmed: false, gone: false })
  })

  it('keeps what it last showed through a timeout, as not confirmed', () => {
    expect(openChatRow(fresh, timeout, known)).toEqual({ row: fresh, confirmed: false, gone: false })
  })

  it('closes only when the server says it’s gone or not the person’s', () => {
    expect(openChatRow(undefined, new ConvexError('That chat doesn’t exist.'), known)).toEqual({
      row: undefined,
      confirmed: true,
      gone: true,
    })
  })

  it('shows the server’s answer once it comes', () => {
    expect(openChatRow(fresh, null, known)).toEqual({ row: fresh, confirmed: true, gone: false })
    expect(openChatRow(undefined, null, known)).toEqual({ row: known, confirmed: false, gone: false })
  })
})
