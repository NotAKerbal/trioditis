import { describe, expect, it } from 'vitest'
import { collageOf } from '../src/data/chats.ts'

// A group with no picture names the members whose pictures make one (ChatPlaintext.collage).
// Metadata is the bridge host's, opened here: anything that isn't a ghost ID is left out.
describe('a chat’s collage', () => {
  it('is the members the metadata names, at most four, each once', () => {
    expect(collageOf({ collage: ['g1', 'g2', 'g1', 'g3', 'g4', 'g5'] })).toEqual(['g1', 'g2', 'g3', 'g4'])
  })

  it('leaves out what isn’t a ghost ID', () => {
    expect(collageOf({ collage: ['g1', '', 7, null, 'g2'] as unknown as string[] })).toEqual(['g1', 'g2'])
    expect(collageOf({ collage: 'g1' as unknown as string[] })).toEqual([])
  })

  it('is empty without metadata or a collage', () => {
    expect(collageOf(null)).toEqual([])
    expect(collageOf({})).toEqual([])
  })
})
