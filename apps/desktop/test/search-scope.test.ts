import { describe, expect, it } from 'vitest'
import { searchScope } from '../src/features/shell/search-scope.ts'

const none = { network: undefined, label: undefined }

describe('the search header', () => {
  it('says all chats only when nothing narrows them', () => {
    expect(searchScope({ searchedAll: true, view: null, ...none })).toBe('Results in all chats')
    expect(searchScope({ searchedAll: false, view: null, ...none })).toBe('Results in loaded chats')
    expect(searchScope({ searchedAll: true, view: 'All chats', ...none })).toBe('Results in the inbox')
    expect(searchScope({ searchedAll: true, view: 'Archived', ...none })).toBe('Results in archived')
  })

  it('names the filters still on, never “all chats” alone', () => {
    expect(searchScope({ searchedAll: true, view: null, network: 'WhatsApp', label: undefined })).toBe(
      'Results in all chats on WhatsApp',
    )
    expect(searchScope({ searchedAll: true, view: null, network: undefined, label: 'Work' })).toBe(
      'Results in all chats labelled “Work”',
    )
    expect(searchScope({ searchedAll: false, view: 'All chats', network: 'Signal', label: 'Family' })).toBe(
      'Results in loaded chats on Signal labelled “Family”',
    )
  })
})
