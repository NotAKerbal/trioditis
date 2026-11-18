import { beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, openJson, openSealedBox, ready, toBase64Url } from '@trioditis/crypto'
import { sealBox, sealJson } from '../convex/lib/seal'

beforeAll(ready)

describe('server-side sealing', () => {
  it('makes sealed boxes libsodium opens', () => {
    const pair = generateKeyPair()
    const message = crypto.getRandomValues(new Uint8Array(32))
    expect(openSealedBox(sealBox(message, pair.publicKey), pair)).toEqual(message)
    expect(() => openSealedBox(sealBox(message, generateKeyPair().publicKey), pair)).toThrow()
  })

  it('makes envelopes packages/crypto opens, bound to their row', () => {
    const pair = generateKeyPair()
    const context = { kind: 'message' as const, ownerUserId: 'user_1', objectId: 'evt_1' }
    const envelope = sealJson({ body: 'hello' }, [toBase64Url(pair.publicKey)], context)
    expect(openJson(envelope, pair, context)).toEqual({ body: 'hello' })
    expect(() => openJson(envelope, pair, { ...context, objectId: 'evt_2' })).toThrow()
  })
})
