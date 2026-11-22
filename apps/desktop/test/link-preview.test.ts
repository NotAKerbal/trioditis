import type { MessagePlaintext } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import { cardReplacesText, fromAddress, linkCards, writtenLinks } from '~/features/chat/link-preview.ts'

const message = (body: string, previews?: unknown[]): MessagePlaintext =>
  ({ type: 'text', body, ...(previews ? { previews } : {}) }) as MessagePlaintext

const picture = { mediaId: 'm1', mime: 'image/jpeg', size: 10, key: 'k', nonce: 'n', width: 1200, height: 630 }

describe('link cards', () => {
  it('shows the network’s preview as it came', () => {
    const body = 'look https://example.com/a'
    const cards = linkCards(
      message(body, [{ url: 'https://example.com/a', title: 'A page', siteName: 'Example', image: picture }]),
      body,
    )
    expect(cards).toEqual([
      {
        kind: 'preview',
        href: 'https://example.com/a',
        host: 'example.com',
        title: 'A page',
        description: undefined,
        siteName: 'Example',
        image: picture,
      },
    ])
  })

  it('never opens anything but a web address, and drops previews with nothing to show', () => {
    const body = 'https://example.com'
    const cards = linkCards(
      message(body, [
        { url: 'javascript:alert(1)', title: 'x' },
        { url: 'https://empty.test' },
        { url: 'https://failed.test', image: { ...picture, failed: true } },
        null,
        'nonsense',
      ]),
      body,
    )
    // None survive, so the text's own link gets a card from its address.
    expect(cards).toEqual([
      { kind: 'address', href: 'https://example.com/', host: 'example.com', service: expect.anything() },
    ])
  })

  it('draws a card from the address alone when the network sent none, for the first link only', () => {
    const body =
      'https://docs.google.com/presentation/d/1gaHFslBSKDqRKiDt67wCF2gBL2cZzU5WI-ebX6qRJ-8/edit?usp=drivesdk and https://youtu.be/x'
    const cards = linkCards(message(body), body)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      kind: 'address',
      host: 'docs.google.com',
      service: { name: 'Google Slides', icon: 'slides' },
      detail: 'Presentation',
    })
  })

  it('shows no card for a message without a web link', () => {
    expect(linkCards(message('see ftp://x.test or mailto:a@b.test'), 'see ftp://x.test or mailto:a@b.test')).toEqual([])
  })
})

describe('what an address says', () => {
  const said = (href: string) => fromAddress(new URL(href))
  it('knows Google’s files, YouTube, GitHub and Maps', () => {
    expect(said('https://docs.google.com/u/1/spreadsheets/d/abc/edit')).toMatchObject({
      service: { name: 'Google Sheets' },
      detail: 'Spreadsheet',
    })
    expect(said('https://docs.google.com/document/d/abc/edit').service.name).toBe('Google Docs')
    expect(said('https://drive.google.com/drive/folders/abc')).toMatchObject({ detail: 'Folder' })
    expect(said('https://www.youtube.com/watch?v=abc')).toMatchObject({ service: { name: 'YouTube' }, detail: 'Video' })
    expect(said('https://youtube.com/shorts/abc').detail).toBe('Short')
    expect(said('https://github.com/NotAKerbal/trioditis/pull/53').detail).toBe(
      'NotAKerbal/trioditis · Pull request #53',
    )
    expect(said('https://www.google.com/maps/place/x').service.name).toBe('Google Maps')
  })
  it('names anywhere else by its site, with the page’s path made readable', () => {
    expect(said('https://www.example.com/blog/my-trip_notes')).toEqual({
      service: { name: 'www.example.com', icon: 'web', tone: 'slate' },
      detail: 'my trip notes',
    })
    expect(said('https://example.com/').detail).toBeUndefined()
    // A path segment that's an inherited property name is no service.
    expect(said('https://docs.google.com/constructor/presentation/d/x').service.name).toBe('Google Slides')
    expect(said('https://docs.google.com/toString/d/x').service).toMatchObject({ icon: 'web' })
    expect(said('https://example.com/%E0%A4%A').detail).toBe('%E0%A4%A')
  })
})

describe('a card standing in for the text', () => {
  const card = (href: string) => linkCards(message(href, [{ url: href, title: 'T' }]), href)
  it('replaces a message that is only the previewed link', () => {
    expect(cardReplacesText(card('https://example.com/a'), ' https://example.com/a ')).toBe(true)
    expect(cardReplacesText(card('https://example.com/a/'), 'https://example.com/a')).toBe(false)
  })
  it('keeps the text when it says more, or when the card is only from the address', () => {
    expect(cardReplacesText(card('https://example.com/a'), 'look https://example.com/a')).toBe(false)
    const body = 'https://example.com/a'
    expect(cardReplacesText(linkCards(message(body), body), body)).toBe(false)
  })
  it('shows a preview only for a link the message has, never one of its own', () => {
    const kinds = (body: string, href: string) =>
      linkCards(message(body, [{ url: href, title: 'Bank sign-in' }]), body).map((c) => [c.kind, c.href])
    // A preview for somewhere the message doesn't link: the card is the message's own link.
    expect(kinds('https://bank.example/', 'https://other.example/')).toEqual([['address', 'https://bank.example/']])
    expect(kinds('no links here', 'https://other.example/')).toEqual([])
    // Not quite the written link: a section, another scheme, host or port.
    for (const written of [
      'https://example.com/a#part-2',
      'http://example.com/a',
      'https://www.example.com/a',
      'https://example.com:8443/a',
    ]) {
      expect(kinds(written, 'https://example.com/a')[0]?.[0]).toBe('address')
    }
    // A link written without its scheme is one the message has.
    expect(kinds('see example.com/a.', 'https://example.com/a')).toEqual([['preview', 'https://example.com/a']])
    expect(kinds('(example.com)', 'https://example.com/')).toEqual([['preview', 'https://example.com/']])
  })
})

describe('where a card says it goes', () => {
  it('shows the whole host, www and all', () => {
    const card = (href: string) => linkCards(message(href, [{ url: href, title: 'T' }]), href)[0]
    expect(card('https://www.example.com/a')?.host).toBe('www.example.com')
    expect(card('https://www./')?.host).toBe('www.')
    const address = linkCards(message('https://www.example.com/'), 'https://www.example.com/')[0]
    expect(address?.host).toBe('www.example.com')
  })
})

describe('links written in a message', () => {
  it('reads a word of thousands of brackets quickly', () => {
    const word = `see x.test/a${')'.repeat(200_000)} and https://y.test/${')'.repeat(200_000)}`
    const started = performance.now()
    // The word too long to be an address isn't one; the link with its scheme is still read.
    expect([...writtenLinks(word)]).toEqual(['https://y.test/'])
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('reads web links and sites written without a scheme, and nothing else', () => {
    expect([...writtenLinks('see https://a.test/x, example.com/b and (www.c.test).')]).toEqual([
      'https://a.test/x',
      'https://example.com/b',
      'https://www.c.test/',
    ])
    expect([...writtenLinks('mailto:a@b.test a@b.test javascript:x.y 1.5 word. localhost/x')]).toEqual([])
    // A closing bracket the link opened is part of it, as for a link with its scheme.
    expect([...writtenLinks('see example.com/archive_(2026) and (example.org/a_(b)).')]).toEqual([
      'https://example.com/archive_(2026)',
      'https://example.org/a_(b)',
    ])
  })
})
