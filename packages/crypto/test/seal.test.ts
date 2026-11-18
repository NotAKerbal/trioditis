import { existsSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  SealError,
  addRecipient,
  decryptMedia,
  encryptMedia,
  fromBase64Url,
  generateKeyPair,
  keyId,
  open,
  openJson,
  ready,
  removeRecipient,
  seal,
  sealJson,
  type Envelope,
  type KeyPair,
  type SealContext,
} from '../src/index.ts'

beforeAll(ready)

const context: SealContext = { kind: 'message', ownerUserId: 'user_1', objectId: 'evt_1' }

describe('seal and open', () => {
  it('round-trips for every recipient', () => {
    const owner = generateKeyPair()
    const agent = generateKeyPair()
    const envelope = sealJson({ body: 'hi' }, [owner, agent], context)
    expect(envelope.keys.map((key) => key.kid)).toEqual([keyId(owner.publicKey), keyId(agent.publicKey)])
    expect(openJson(envelope, owner, context)).toEqual({ body: 'hi' })
    expect(openJson(envelope, agent, context)).toEqual({ body: 'hi' })
  })

  it('refuses a key that is not a recipient', () => {
    const envelope = sealJson({ body: 'hi' }, [generateKeyPair()], context)
    expect(() => open(envelope, generateKeyPair(), context)).toThrow(SealError)
  })

  it('binds ciphertext to its row', () => {
    const owner = generateKeyPair()
    const envelope = sealJson({ body: 'hi' }, [owner], context)
    expect(() => open(envelope, owner, { ...context, objectId: 'evt_2' })).toThrow(SealError)
    expect(() => open(envelope, owner, { ...context, ownerUserId: 'user_2' })).toThrow(SealError)
    expect(() => open(envelope, owner, { ...context, kind: 'chat' })).toThrow(SealError)
  })

  it('detects tampering', () => {
    const owner = generateKeyPair()
    const envelope = sealJson({ body: 'hi' }, [owner], context)
    const ct = fromBase64Url(envelope.ct)
    ct[0] = (ct[0] ?? 0) ^ 1
    const tampered: Envelope = { ...envelope, ct: Buffer.from(ct).toString('base64url') }
    expect(() => open(tampered, owner, context)).toThrow(SealError)
  })

  it('uses a fresh nonce and content key each time', () => {
    const owner = generateKeyPair()
    const a = seal(new Uint8Array([1, 2, 3]), [owner], context)
    const b = seal(new Uint8Array([1, 2, 3]), [owner], context)
    expect(a.nonce).not.toEqual(b.nonce)
    expect(a.ct).not.toEqual(b.ct)
  })

  it('needs a recipient, an owner and an object ID', () => {
    expect(() => seal(new Uint8Array(), [], context)).toThrow(SealError)
    expect(() => seal(new Uint8Array(), [generateKeyPair()], { ...context, objectId: '' })).toThrow(SealError)
  })

  it('lists a repeated recipient once', () => {
    const owner = generateKeyPair()
    expect(seal(new Uint8Array([1]), [owner, owner], context).keys).toHaveLength(1)
  })

  it('rejects other envelope versions', () => {
    const owner = generateKeyPair()
    const envelope = { ...sealJson({}, [owner], context), v: 2 } as unknown as Envelope
    expect(() => open(envelope, owner, context)).toThrow(/version/)
  })
})

describe('recipients', () => {
  let owner: KeyPair
  let agent: KeyPair
  beforeAll(() => {
    owner = generateKeyPair()
    agent = generateKeyPair()
  })

  it('adds a recipient without changing the content', () => {
    const envelope = sealJson({ body: 'history' }, [owner], context)
    const granted = addRecipient(envelope, owner, agent, context)
    expect(granted.ct).toEqual(envelope.ct)
    expect(openJson(granted, agent, context)).toEqual({ body: 'history' })
    expect(addRecipient(granted, owner, agent, context)).toBe(granted)
  })

  it('refuses to re-share an envelope for the wrong row', () => {
    const envelope = sealJson({ body: 'history' }, [owner], context)
    expect(() => addRecipient(envelope, owner, agent, { ...context, objectId: 'other' })).toThrow(SealError)
  })

  it('removes a recipient but never the last one', () => {
    const envelope = sealJson({ body: 'x' }, [owner, agent], context)
    const revoked = removeRecipient(envelope, keyId(agent.publicKey))
    expect(() => open(revoked, agent, context)).toThrow(SealError)
    expect(openJson(revoked, owner, context)).toEqual({ body: 'x' })
    expect(() => removeRecipient(revoked, keyId(owner.publicKey))).toThrow(SealError)
  })
})

describe('media', () => {
  it('round-trips and binds to its owner and ID', () => {
    const bytes = new TextEncoder().encode('file contents')
    const media = encryptMedia(bytes, 'user_1', 'media_1')
    expect(decryptMedia(media.ciphertext, media.key, media.nonce, 'user_1', 'media_1')).toEqual(bytes)
    expect(() => decryptMedia(media.ciphertext, media.key, media.nonce, 'user_1', 'media_2')).toThrow(SealError)
  })
})

interface VectorFile {
  recipients: { name: string; publicKey: string; privateKey: string; kid: string }[]
  envelopes: { name: string; context: SealContext; recipients: string[]; plaintext: unknown; envelope: Envelope }[]
  media: { ownerUserId: string; mediaId: string; plaintext: string; ciphertext: string; key: string; nonce: string }[]
}

function checkVectors(file: URL) {
  const vectors = JSON.parse(readFileSync(file, 'utf8')) as VectorFile
  const keys = new Map(
    vectors.recipients.map((key) => [
      key.name,
      { publicKey: fromBase64Url(key.publicKey), privateKey: fromBase64Url(key.privateKey), kid: key.kid },
    ]),
  )
  for (const key of keys.values()) expect(keyId(key.publicKey)).toEqual(key.kid)
  for (const vector of vectors.envelopes) {
    for (const name of vector.recipients) {
      expect(openJson(vector.envelope, keys.get(name)!, vector.context), vector.name).toEqual(vector.plaintext)
    }
  }
  for (const media of vectors.media) {
    const plaintext = decryptMedia(
      fromBase64Url(media.ciphertext),
      media.key,
      media.nonce,
      media.ownerUserId,
      media.mediaId,
    )
    expect(plaintext).toEqual(fromBase64Url(media.plaintext))
  }
}

describe('shared vectors', () => {
  it('opens the vectors this package wrote', () => {
    checkVectors(new URL('../testdata/vectors.json', import.meta.url))
  })

  // Written by the Go implementation's tests (apps/bridge-host), so each side opens what the
  // other sealed.
  const goVectors = new URL('../testdata/vectors-go.json', import.meta.url)
  it.runIf(existsSync(goVectors))('opens the vectors the Go implementation wrote', () => {
    checkVectors(goVectors)
  })
})
