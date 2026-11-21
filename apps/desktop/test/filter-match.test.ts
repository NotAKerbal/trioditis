import { describe, expect, it } from 'vitest'
import { inFilter, viewOf } from '../src/features/shell/filter-match.ts'

const row = {
  labelIds: ['l1'],
  blocked: false,
  isRequest: false,
  snoozedUntil: null as number | null,
  woke: false,
  archived: false,
}

describe('viewOf', () => {
  it('follows the backend precedence', () => {
    expect(viewOf({ ...row, blocked: true, isRequest: true })).toBe('blocked')
    expect(viewOf({ ...row, isRequest: true, archived: true })).toBe('requests')
    expect(viewOf({ ...row, snoozedUntil: 5, archived: true })).toBe('snoozed')
    expect(viewOf({ ...row, snoozedUntil: 5, woke: true })).toBe('inbox')
    expect(viewOf({ ...row, archived: true })).toBe('archived')
  })
})

describe('inFilter', () => {
  const chat = { network: 'signal', row }
  it('keeps a chat matching the network and label, in any view under Focused', () => {
    expect(inFilter(chat, { network: 'signal', labelId: 'l1', view: null })).toBe(true)
    expect(
      inFilter({ ...chat, row: { ...row, archived: true } }, { network: undefined, labelId: undefined, view: null }),
    ).toBe(true)
  })
  it('drops a chat on another network, without the label, or in another Simple view', () => {
    expect(inFilter(chat, { network: 'whatsapp', labelId: undefined, view: null })).toBe(false)
    expect(inFilter(chat, { network: undefined, labelId: 'l2', view: null })).toBe(false)
    expect(inFilter(chat, { network: undefined, labelId: undefined, view: 'archived' })).toBe(false)
    expect(inFilter(chat, { network: undefined, labelId: undefined, view: 'inbox' })).toBe(true)
  })
})
