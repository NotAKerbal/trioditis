import { describe, expect, it } from 'vitest'
import { linksToShow } from '../src/features/settings/member-links.ts'

const made = (invitationId: string) => ({
  invitationId,
  email: `${invitationId}@x.test`,
  link: `https://t.test/invite#${invitationId}`,
})

describe('invitation links made on this page', () => {
  const links = [made('a'), made('b'), made('c')]

  it('all show before the list loads', () => {
    expect(linksToShow(links, undefined, false)).toHaveLength(3)
  })

  it('show while their invitation waits, and not once it has expired, been joined or revoked', () => {
    const listed = [
      { _id: 'a', expiresAt: 2_000 },
      { _id: 'b', expiresAt: 500 },
    ]
    expect(linksToShow(links, listed, true, 1_000).map((l) => l.invitationId)).toEqual(['a'])
  })

  it('stay while more pages are left to load, since theirs may be on one', () => {
    const listed = [{ _id: 'a', expiresAt: 2_000 }]
    expect(linksToShow(links, listed, false, 1_000).map((l) => l.invitationId)).toEqual(['a', 'b', 'c'])
  })
})
