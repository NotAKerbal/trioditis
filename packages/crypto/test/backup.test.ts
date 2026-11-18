import { beforeAll, describe, expect, it } from 'vitest'
import {
  SealError,
  authPassword,
  makeKeyBackup,
  makeKeySetup,
  toBase64Url,
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

describe('auth passwords', () => {
  it('is the same for the same password and email, whatever the email’s case or the password’s form', () => {
    const one = authPassword('Ångström', 'Sam@Example.com')
    expect(one).toBe(authPassword('A\u030angstro\u0308m', ' sam@example.com '))
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(one).not.toBe(authPassword('Ångström', 'alex@example.com'))
    expect(one).not.toContain('Ångström')
  })

  it('never equals the key backup’s wrapping key', () => {
    const params = newPasswordParams()
    expect(authPassword('pw pw pw pw', 'a@b.c')).not.toBe(toBase64Url(passwordKey('pw pw pw pw', params)))
  })

  it('makes everything keys.setup takes, opening with the password or the recovery key', () => {
    const identity = generateKeyPair()
    const { args, recoveryText } = makeKeySetup(identity.privateKey, 'demo password', 'user_1')
    const kid = keyId(identity.publicKey)
    expect(args.publicKey).toBe(toBase64Url(identity.publicKey))
    expect(
      unwrapIdentityKey(
        args.recovery,
        decodeRecoveryKey(recoveryText),
        { userId: 'user_1', kid, kind: 'recovery' },
        identity.publicKey,
      ).privateKey,
    ).toEqual(identity.privateKey)
  })

  it('makes a password backup that the normal unlock opens', () => {
    const identity = generateKeyPair()
    const backup = makeKeyBackup(identity.privateKey, 'demo password', 'user_1')
    expect(backup.kid).toBe(keyId(identity.publicKey))
    const opened = unwrapIdentityKey(
      backup.password,
      passwordKey('demo password', backup.password.params),
      { userId: 'user_1', kid: backup.kid, kind: 'password' },
      identity.publicKey,
    )
    expect(opened.privateKey).toEqual(identity.privateKey)
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

  it('accepts only one spelling of each key', () => {
    const { text } = generateRecoveryKey()
    // The last character carries three padding bits; setting one changes the spelling only.
    const last = text.at(-1)!
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    const padded = alphabet[alphabet.indexOf(last) | 1]!
    if (padded !== last) expect(() => decodeRecoveryKey(text.slice(0, -1) + padded)).toThrow(SealError)
  })

  it('encodes exactly 32 bytes', () => {
    expect(() => encodeRecoveryKey(new Uint8Array(31))).toThrow(SealError)
  })
})
