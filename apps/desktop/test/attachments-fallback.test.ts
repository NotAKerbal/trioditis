import { describe, expect, it, vi } from 'vitest'

// The tile's words, without the media loader, which reads the app's config when it loads.
vi.mock('~/data/media.ts', () => ({}))
vi.mock('~/lib/session.tsx', () => ({}))
const { tileStatus } = await import('../src/features/chat/attachments.tsx')

describe('files that can’t be shown or played', () => {
  it('says so, so the tile’s Save is the way to open them', () => {
    expect(tileStatus({ cantPlay: true, state: 'ready', size: 10 })).toBe('Can’t be played here')
    expect(tileStatus({ note: 'Can’t be shown here', cantPlay: false, state: 'idle', size: 10 })).toBe(
      'Can’t be shown here',
    )
    expect(tileStatus({ cantPlay: false, state: 'idle', size: 2048 })).toBe('2 KB')
  })
})
