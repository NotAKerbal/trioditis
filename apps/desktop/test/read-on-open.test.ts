import { describe, expect, it } from 'vitest'
import { NOTHING_READ, readOnOpen, type OpenChat, type ReadOnOpen } from '~/data/read-on-open.ts'

const chat = (overrides: Partial<OpenChat> = {}): OpenChat => ({
  id: 'c1',
  unread: 0,
  markedUnread: false,
  lastMessageId: 'm1',
  ...overrides,
})

/** Runs the decisions in order, as the effect does, and returns which of them marked read. */
function run(steps: [OpenChat | null | undefined, boolean][]) {
  let done: ReadOnOpen = NOTHING_READ
  return steps.map(([open, visible]) => {
    const next = readOnOpen(open, visible, done)
    done = next.done
    return next.mark
  })
}

describe('marking the open chat read', () => {
  it('marks a chat read when it’s opened with unread, or marked unread', () => {
    expect(run([[chat({ unread: 2 }), true]])).toEqual([true])
    expect(run([[chat({ markedUnread: true }), true]])).toEqual([true])
    expect(run([[chat(), true]])).toEqual([false])
  })

  it('waits for a chat opened by a link while the window is hidden until it’s seen', () => {
    expect(
      run([
        [undefined, false],
        [chat({ unread: 1 }), false],
        [chat({ unread: 1 }), true],
      ]),
    ).toEqual([false, false, true])
  })

  it('marks it read again for each message that arrives while it’s open, once', () => {
    expect(
      run([
        [chat({ unread: 1 }), true],
        // The mark is on its way: the count hasn't come back as 0 yet.
        [chat({ unread: 1 }), true],
        [chat({ unread: 0 }), true],
        [chat({ unread: 1, lastMessageId: 'm2' }), true],
      ]),
    ).toEqual([true, false, false, true])
  })

  it('leaves unread what arrives while the window isn’t seen, until it is', () => {
    expect(
      run([
        [chat(), true],
        [chat({ unread: 1, lastMessageId: 'm2' }), false],
        [chat({ unread: 2, lastMessageId: 'm3' }), false],
        [chat({ unread: 2, lastMessageId: 'm3' }), true],
      ]),
    ).toEqual([false, false, false, true])
  })

  it('keeps a chat the person marked unread while it was open unread', () => {
    expect(
      run([
        [chat(), true],
        [chat({ markedUnread: true }), true],
        [chat({ unread: 1, markedUnread: true, lastMessageId: 'm2' }), true],
      ]),
    ).toEqual([false, false, false])
  })

  it('treats closing and opening the same chat again as a new opening', () => {
    expect(
      run([
        [chat({ unread: 1 }), true],
        [null, true],
        [chat({ markedUnread: true }), true],
      ]),
    ).toEqual([true, false, true])
  })
})
