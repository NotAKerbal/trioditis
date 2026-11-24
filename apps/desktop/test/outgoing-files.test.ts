import { decryptMedia, ready } from '@trioditis/crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const upload = vi.fn()
vi.mock('~/lib/convex.ts', () => ({ convex: { mutation: (...args: unknown[]) => upload(...args) } }))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({}) }))

const { uploadFile, readyMediaUrl, messageTypeOf } = await import('../src/data/media.ts')
const { addFiles, filesOf, pastedFiles, removeFile, MAX_FILES } = await import('../src/features/chat/outgoing-files.ts')

beforeAll(() => ready())
afterEach(() => {
  upload.mockReset()
  vi.unstubAllGlobals()
})

/** A clipboard or drag holding these files and this text. */
function transfer(files: File[], text = ''): DataTransfer {
  return {
    files,
    types: files.length ? ['Files', ...(text ? ['text/plain'] : [])] : ['text/plain'],
    getData: (type: string) => (type === 'text/plain' ? text : ''),
  } as unknown as DataTransfer
}

describe('pasting', () => {
  const shot = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' })

  it('attaches a screenshot or a copied file', () => {
    expect(pastedFiles(transfer([shot]))).toEqual([shot])
    expect(pastedFiles(transfer([shot], 'image.png'))).toEqual([shot])
  })

  it('pastes text that came with a picture of it, as from a spreadsheet', () => {
    expect(pastedFiles(transfer([shot], 'A1\tB1'))).toEqual([])
    expect(pastedFiles(transfer([], 'hello'))).toEqual([])
  })
})

describe('files in the composer', () => {
  it('keeps them by chat, up to a limit', () => {
    const many = Array.from({ length: MAX_FILES + 2 }, (_, i) => new File(['x'], `f${i}.txt`))
    expect(addFiles('chat-a', many)).toMatch(/Up to/)
    expect(filesOf('chat-a')).toHaveLength(MAX_FILES)
    expect(filesOf('chat-b')).toHaveLength(0)
    for (const f of filesOf('chat-a')) removeFile('chat-a', f.id)
    expect(filesOf('chat-a')).toHaveLength(0)
  })
})

describe('sending a file', () => {
  it('gives the gateway only ciphertext, under the chat’s upload token, and returns its key', async () => {
    upload.mockResolvedValue({ token: 'up1', expiresAt: Date.now() + 900_000 })
    const puts: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        puts.push({ url, init })
        return new Response(null, { status: 201 })
      }),
    )
    const photo = new File([new Uint8Array([9, 8, 7])], 'photo.jpg', { type: 'image/jpeg' })
    const att = await uploadFile('user_a', 'chat-1', photo)
    expect(upload).toHaveBeenCalledWith(expect.anything(), { chatId: 'chat-1' })
    expect(puts).toHaveLength(1)
    expect(puts[0]!.url).toBe(`/media/${att.mediaId}`)
    expect(puts[0]!.init.method).toBe('PUT')
    expect((puts[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer up1')
    const sent = puts[0]!.init.body as Uint8Array
    expect(decryptMedia(sent, att.key, att.nonce, 'user_a', att.mediaId)).toEqual(new Uint8Array([9, 8, 7]))
    expect(att).toMatchObject({ mime: 'image/jpeg', size: 3, name: 'photo.jpg' })
    // The sender's own picture shows from what they picked.
    expect(readyMediaUrl('user_a', att)).toBe('data:image/jpeg;base64,CQgH')
  })

  it('counts a retried put that finds its ID in use as kept', async () => {
    upload.mockResolvedValue({ token: 'up2', expiresAt: Date.now() + 900_000 })
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(new Response(null, { status: 502 }))
          .mockResolvedValueOnce(new Response(null, { status: 409 })),
      )
      const sent = uploadFile('user_b', 'chat-2', new File(['x'], 'a.txt', { type: 'text/plain' }))
      await vi.runAllTimersAsync()
      expect((await sent).mime).toBe('text/plain')
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes as a picture, video, sound or file by its type', () => {
    expect(messageTypeOf('image/png')).toBe('image')
    expect(messageTypeOf('image/svg+xml')).toBe('file')
    expect(messageTypeOf('video/mp4')).toBe('video')
    expect(messageTypeOf('audio/ogg')).toBe('audio')
    expect(messageTypeOf('')).toBe('file')
  })
})
