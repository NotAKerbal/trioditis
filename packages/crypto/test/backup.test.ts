import { beforeAll, describe, expect, it } from 'vitest'
import {
  SealError,
  decodeRecoveryKey,
  encodeRecoveryKey,
  generateKeyPair,
  generateRecoveryKey,
  keyId,
  newPasswordParams,
  passwordKey,
  ready,
  unwrapIdentityKey,
  wrapIdentityKey,
  type KeyBackupContext,
} from '../src/index.ts'

beforeAll(ready)

describe('identity key backups', () => {
  it('round-trips through a password and binds to the person, key and kind', () => {
    const identity = generateKeyPair()
    const context: KeyBackupContext = { userId: 'user_1', kid: keyId(identity.publicKey), kind: 'password' }
    const params = newPasswordParams()
    const wrapped = wrapIdentityKey(identity.privateKey, passwordKey('correct horse battery', params), context)
    const opened = unwrapIdentityKey(wrapped, passwordKey('correct horse battery', params), context, identity.publicKey)
    expect(opened.privateKey).toEqual(identity.privateKey)
    expect(() => unwrapIdentityKey(wrapped, passwordKey('wrong', params), context, identity.publicKey)).toThrow(
      SealError,
    )
    expect(() =>
      unwrapIdentityKey(
        wrapped,
        passwordKey('correct horse battery', params),
        { ...context, userId: 'user_2' },
        identity.publicKey,
      ),
    ).toThrow(SealError)
    expect(() =>
      unwrapIdentityKey(
        wrapped,
        passwordKey('correct horse battery', params),
        { ...context, kind: 'recovery' },
        identity.publicKey,
      ),
    ).toThrow(SealError)
  })

  it('refuses a backup that holds a different key', () => {
    const identity = generateKeyPair()
    const other = generateKeyPair()
    const recovery = generateRecoveryKey()
    const context: KeyBackupContext = { userId: 'user_1', kid: keyId(identity.publicKey), kind: 'recovery' }
    const wrapped = wrapIdentityKey(other.privateKey, recovery.bytes, context)
    expect(() => unwrapIdentityKey(wrapped, recovery.bytes, context, identity.publicKey)).toThrow(/different key/)
  })

  it('uses a fresh salt per password', () => {
    expect(newPasswordParams().salt).not.toEqual(newPasswordParams().salt)
  })
})

describe('recovery keys', () => {
  it('round-trips, forgiving case, spaces, dashes and look-alike letters', () => {
    const { bytes, text } = generateRecoveryKey()
    expect(text).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(decodeRecoveryKey(text)).toEqual(bytes)
    expect(decodeRecoveryKey(text.toLowerCase().replaceAll('-', ' '))).toEqual(bytes)
    expect(decodeRecoveryKey(text.replaceAll('0', 'O').replaceAll('1', 'l'))).toEqual(bytes)
  })

  it('catches a typo', () => {
    const { text } = generateRecoveryKey()
    const first = text[0] === 'A' ? 'B' : 'A'
    expect(() => decodeRecoveryKey(first + text.slice(1))).toThrow(SealError)
    expect(() => decodeRecoveryKey('not a key')).toThrow(SealError)
  })

  it('encodes exactly 32 bytes', () => {
    expect(() => encodeRecoveryKey(new Uint8Array(31))).toThrow(SealError)
  })
})
