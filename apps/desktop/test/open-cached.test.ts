import { generateKeyPair, keyId, ready, sealJson, toBase64Url } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { openCached } from '../src/lib/sealed.ts'

describe('remembering what was opened', () => {
  beforeAll(ready)

  const setup = () => {
    const keyPair = generateKeyPair()
    const kid = keyId(keyPair.publicKey)
    const envelope = sealJson({ body: 'hello' }, [{ publicKey: keyPair.publicKey }], {
      kind: 'message',
      ownerUserId: 'u1',
      objectId: 'e1',
    })
    return { keyPair, kid, envelope, cache: new Map<string, { body: string } | null>() }
  }

  it('opens once, then answers from the cache', () => {
    const { keyPair, kid, envelope, cache } = setup()
    expect(openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e1')).toEqual({ body: 'hello' })
    expect(cache.size).toBe(1)
    expect(openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e1')).toEqual({ body: 'hello' })
    expect(cache.size).toBe(1)
  })

  it('opens afresh, and refuses, when the object ID no longer matches', () => {
    const { keyPair, kid, envelope, cache } = setup()
    openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e1')
    // The same ciphertext presented as another object's: its associated data doesn't match.
    expect(openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e2')).toBeNull()
  })

  it('opens afresh, and refuses, when the nonce changed under the same ciphertext', () => {
    const { keyPair, kid, envelope, cache } = setup()
    openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e1')
    const tampered = { ...envelope, nonce: toBase64Url(new Uint8Array(24)) }
    expect(openCached(cache, tampered, keyPair, kid, 'message', 'u1', 'e1')).toBeNull()
  })

  it('keeps one person’s results from another', () => {
    const { keyPair, kid, envelope, cache } = setup()
    openCached(cache, envelope, keyPair, kid, 'message', 'u1', 'e1')
    const other = generateKeyPair()
    expect(openCached(cache, envelope, other, keyId(other.publicKey), 'message', 'u1', 'e1')).toBeNull()
  })

  it('keeps at most `max` results', () => {
    const { keyPair, kid, envelope, cache } = setup()
    for (const objectId of ['a', 'b', 'c']) openCached(cache, envelope, keyPair, kid, 'message', 'u1', objectId, 2)
    expect(cache.size).toBe(2)
  })
})
