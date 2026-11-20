import { describe, expect, it } from 'vitest'
import { isBigEmoji, linkParts, sameRun, sameTime } from '../src/features/chat/message-text.ts'

const at = new Date(2026, 10, 19, 12, 0).getTime()
const msg = (minutes: number, self = false, ghostId: string | undefined = 'g1') => ({
  self,
  ghostId,
  at: at + minutes * 60_000,
})

describe('runs of joined bubbles', () => {
  it('joins one sender’s messages close together', () => {
    expect(sameRun(msg(0), msg(14))).toBe(true)
    expect(sameRun(msg(0, true, undefined), msg(1, true, undefined))).toBe(true)
  })

  it('breaks on another sender, a long gap or a new day', () => {
    expect(sameRun(msg(0), msg(1, false, 'g2'))).toBe(false)
    expect(sameRun(msg(0), msg(1, true, undefined))).toBe(false)
    expect(sameRun(msg(0), msg(15))).toBe(false)
    expect(sameRun(msg(11 * 60 + 58), msg(12 * 60 + 3))).toBe(false)
    expect(sameRun(undefined, msg(0))).toBe(false)
  })
})

describe('one time for messages around the same time', () => {
  it('shares a time across senders, until a 15-minute gap or a new day', () => {
    expect(sameTime(msg(0), msg(14, true, undefined))).toBe(true)
    expect(sameTime(msg(0), msg(15))).toBe(false)
    expect(sameTime(msg(11 * 60 + 58), msg(12 * 60 + 3))).toBe(false)
    expect(sameTime(undefined, msg(0))).toBe(false)
  })
})

describe('links in a message', () => {
  it('links web addresses and leaves trailing punctuation as text', () => {
    expect(linkParts('see https://example.com/a?b=1.')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: '.' },
    ])
    expect(linkParts('(http://x.test/path)')[1]).toEqual({
      kind: 'link',
      text: 'http://x.test/path',
      href: 'http://x.test/path',
    })
  })

  it('keeps brackets that belong to the address', () => {
    const link = (text: string) => linkParts(text).find((p) => p.kind === 'link')?.text
    expect(link('https://en.wikipedia.org/wiki/Mercury_(planet)')).toBe(
      'https://en.wikipedia.org/wiki/Mercury_(planet)',
    )
    expect(link('(see https://en.wikipedia.org/wiki/Mercury_(planet)).')).toBe(
      'https://en.wikipedia.org/wiki/Mercury_(planet)',
    )
    expect(link('http://[::1]:8080/x')).toBe('http://[::1]:8080/x')
    expect(link('[http://[::1]]')).toBe('http://[::1]')
  })

  it('leaves an address the browser can’t read as text', () => {
    expect(linkParts('go to http://[nope] now')).toEqual([{ kind: 'text', text: 'go to http://[nope] now' }])
  })

  it('links nothing but http and https', () => {
    expect(linkParts('javascript:alert(1) file:///etc/passwd')).toEqual([
      { kind: 'text', text: 'javascript:alert(1) file:///etc/passwd' },
    ])
    expect(linkParts('')).toEqual([])
  })
})

describe('emoji shown large', () => {
  it('takes one to three emoji, with skin tones and joiners', () => {
    expect(isBigEmoji('😂')).toBe(true)
    expect(isBigEmoji(' 👍🏽 ❤️ ')).toBe(true)
    expect(isBigEmoji('👨‍👩‍👧')).toBe(true)
    expect(isBigEmoji('👨‍👩‍👧‍👦')).toBe(true)
    expect(isBigEmoji('🇺🇸')).toBe(true)
    expect(isBigEmoji('1️⃣')).toBe(true)
    expect(isBigEmoji('🏴󠁧󠁢󠁳󠁣󠁴󠁿')).toBe(true)
  })

  it('leaves text, digits and longer runs in a bubble', () => {
    expect(isBigEmoji('ok 👍')).toBe(false)
    expect(isBigEmoji('123')).toBe(false)
    expect(isBigEmoji('#')).toBe(false)
    expect(isBigEmoji('😂😂😂😂')).toBe(false)
    expect(isBigEmoji('🇺🇸🇺🇸🇺🇸🇺🇸')).toBe(false)
    expect(isBigEmoji('')).toBe(false)
  })
})
