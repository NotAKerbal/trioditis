import { describe, expect, it } from 'vitest'
import { NOTHING_READ, readOnOpen, type OpenChat, type ReadOnOpen } from '~/data/read-on-open.ts'

const chat = (overrides: Partial<OpenChat> = {}): OpenChat => ({
  id: 'c1',
  unread: 0,
  markedUnread: false,
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

  it('marks it read again for each message that arrives while it’s open, once per count', () => {
    expect(
      run([
        [chat({ unread: 1 }), true],
        // The mark is on its way: the count hasn't come back as 0 yet.
        [chat({ unread: 1 }), true],
        [chat({ unread: 0 }), true],
        [chat({ unread: 1 }), true],
        [chat({ unread: 0 }), true],
      ]),
    ).toEqual([true, false, false, true, false])
  })

  it('marks a count that rises while the preview stays the same', () => {
    // A late message sorts before the person's own copy still sending, which stays the preview:
    // only the count says something arrived.
    expect(
      run([
        [chat(), true],
        [chat({ unread: 1 }), true],
        // Another arrives before the first mark's answer.
        [chat({ unread: 2 }), true],
      ]),
    ).toEqual([false, true, true])
  })

  it('doesn’t send a failed mark again until the count changes', () => {
    expect(
      run([
        [chat({ unread: 1 }), true],
        [chat({ unread: 1 }), false],
        [chat({ unread: 1 }), true],
        [chat({ unread: 2 }), true],
      ]),
    ).toEqual([true, false, false, true])
  })

  it('leaves unread what arrives while the window isn’t seen, until it is', () => {
    expect(
      run([
        [chat(), true],
        [chat({ unread: 1 }), false],
        [chat({ unread: 2 }), false],
        [chat({ unread: 2 }), true],
      ]),
    ).toEqual([false, false, false, true])
  })

  it('keeps a chat the person marked unread while it was open unread', () => {
    expect(
      run([
        [chat(), true],
        [chat({ markedUnread: true }), true],
        [chat({ unread: 1, markedUnread: true }), true],
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
