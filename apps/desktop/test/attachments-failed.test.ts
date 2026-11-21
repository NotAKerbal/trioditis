// @vitest-environment happy-dom
import type { Attachment } from '@trioditis/core'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

// A file the bridge host couldn't store comes with no media ID, key or nonce. Nothing may try to
// fetch it, and the tile mustn't offer Save or Play, which could never succeed.
const loads: unknown[] = []
vi.mock('~/data/media.ts', () => ({
  isImage: (a: Attachment) => a.mime.startsWith('image/'),
  isVideo: (a: Attachment) => a.mime.startsWith('video/'),
  isAudio: (a: Attachment) => a.mime.startsWith('audio/'),
  loadsByItself: () => true,
  playable: () => true,
  saveMedia: () => Promise.reject(new Error('unused')),
  useMedia: (...args: unknown[]) => {
    loads.push(args)
    return { state: 'idle', load: () => {} }
  },
}))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({ userId: 'u1' }) }))
const { Attachments } = await import('../src/features/chat/attachments.tsx')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const failed = (name: string, mime: string): Attachment => ({
  mediaId: '',
  key: '',
  nonce: '',
  name,
  mime,
  size: 1000,
  failed: true,
})

describe('a file the bridge host couldn’t keep', () => {
  it('shows its name as not available, with nothing to open, play or save', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    await act(async () => {
      root.render(
        createElement(Attachments, {
          network: 'whatsapp',
          attachments: [failed('beach.jpg', 'image/jpeg'), failed('voice.ogg', 'audio/ogg')],
        }),
      )
    })
    expect(host.textContent).toContain('beach.jpg')
    expect(host.textContent).toContain('voice.ogg')
    expect(host.textContent?.match(/Not available/g)).toHaveLength(2)
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(loads).toHaveLength(0)
    await act(async () => root.unmount())
  })
})
