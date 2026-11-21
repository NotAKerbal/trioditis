import { generateKeyPair, keyId, ready, sealJson } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { captionOf, openLastMessage, summarize } from '../src/data/last-message.ts'

describe('a chat’s last message, for the list', () => {
  beforeAll(ready)

  const identity = () => {
    const keyPair = generateKeyPair()
    return { keyPair, kid: keyId(keyPair.publicKey), userId: 'u1' }
  }
  const last = (id: ReturnType<typeof identity>, body: unknown, objectId = 'e1', sealedFor = objectId) => ({
    messageId: 'm1',
    at: 1234,
    self: false,
    ghostId: 'g1',
    redacted: false,
    sealed: sealJson(body, [{ publicKey: id.keyPair.publicKey }], {
      kind: 'message',
      ownerUserId: 'u1',
      objectId: sealedFor,
    }),
    objectId,
  })

  it('opens it as a message is opened, keeping its time and sender', () => {
    const id = identity()
    expect(openLastMessage(last(id, { type: 'text', body: ' See you at 7 ' }), id)).toEqual({
      at: 1234,
      self: false,
      redacted: false,
      text: 'See you at 7',
    })
  })

  it('shows nothing it can’t open: sealed for another object, too big, or deleted', () => {
    const id = identity()
    expect(openLastMessage(last(id, { type: 'text', body: 'x' }, 'e2', 'e1'), id)?.text).toBeNull()
    expect(openLastMessage({ ...last(id, { type: 'text', body: 'x' }), sealed: null }, id)?.text).toBeNull()
    const deleted = openLastMessage({ ...last(id, { type: 'text', body: 'x' }), redacted: true, sealed: null }, id)
    expect(deleted).toMatchObject({ redacted: true, text: null })
  })

  it('has no preview until the row carries one', () => {
    expect(openLastMessage(null, identity())).toBeNull()
  })

  it('names a message without text by what it is', () => {
    expect(summarize({ type: 'image', body: '' })).toBe('Photo')
    expect(summarize({ type: 'file', body: '  ' })).toBe('File')
    expect(summarize({ type: 'emote', body: 'waves' })).toBe('* waves')
    expect(summarize({ type: 'notice', body: '' })).toBeNull()
    expect(summarize(null)).toBeNull()
  })

  it('takes a picture’s file name for no caption, as networks send one', () => {
    const photo = { mediaId: 'm', mime: 'image/jpeg', size: 1, key: 'k', nonce: 'n', name: 'image-2256.jpg' }
    expect(summarize({ type: 'image', body: 'image-2256.jpg', attachments: [photo] })).toBe('Photo')
    expect(captionOf({ type: 'image', body: 'image-2256.jpg', attachments: [photo] })).toBe('')
    expect(captionOf({ type: 'image', body: 'The awards', attachments: [photo] })).toBe('The awards')
    // Without the file, the name is all there is to show.
    expect(summarize({ type: 'image', body: 'image-2256.jpg' })).toBe('image-2256.jpg')
  })
})
