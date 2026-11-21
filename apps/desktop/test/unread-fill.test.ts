import { describe, expect, it } from 'vitest'
import { unreadIncomplete } from '../src/features/shell/unread-fill.ts'

describe('unreadIncomplete', () => {
  it('is done once the inbox has no more pages', () => {
    expect(unreadIncomplete({ more: false, loadedUnread: 0, count: { count: 5, more: false } })).toBe(false)
    expect(unreadIncomplete({ more: false, loadedUnread: 0, count: undefined })).toBe(false)
  })

  it('keeps loading until every counted unread chat is loaded', () => {
    expect(unreadIncomplete({ more: true, loadedUnread: 2, count: { count: 3, more: false } })).toBe(true)
    expect(unreadIncomplete({ more: true, loadedUnread: 3, count: { count: 3, more: false } })).toBe(false)
  })

  it('stops with nothing unread', () => {
    expect(unreadIncomplete({ more: true, loadedUnread: 0, count: { count: 0, more: false } })).toBe(false)
  })

  it('loads to the end without a count, or with one that stops short', () => {
    expect(unreadIncomplete({ more: true, loadedUnread: 40, count: undefined })).toBe(true)
    expect(unreadIncomplete({ more: true, loadedUnread: 120, count: { count: 99, more: true } })).toBe(true)
  })
})
