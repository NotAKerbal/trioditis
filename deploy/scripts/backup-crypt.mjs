// Encrypts (or decrypts) a backup's files with the install's BACKUP_KEY: `node backup-crypt.mjs
// encrypt|decrypt`, stdin to stdout. deploy/trioditis runs it in the bundle's Node image, with no
// network and no log, and hands it the key by name in the environment, never as an argument.
//
// The format: the line `trioditis-backup-v1`, a random 32-byte salt, then the data in 64 KiB
// chunks, each sealed with AES-256-GCM under a key derived from BACKUP_KEY and the salt
// (HKDF-SHA256). A chunk's nonce is its number and whether it's the last, so chunks can't be
// reordered, dropped, or cut off at the end without decrypting failing. Decrypting writes only
// chunks that check out, and exits 1 at the first one that doesn't, so a reader that stops at a
// failure has read nothing forged.

import { once } from 'node:events'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const MAGIC = Buffer.from('trioditis-backup-v1\n')
const SALT = 32
const CHUNK = 64 * 1024
const TAG = 16

function fail(message) {
  process.stderr.write(`backup-crypt: ${message}\n`)
  process.exit(1)
}

// The last argument, run as a file or (as deploy/trioditis runs it) as `node -e <its text>`.
const mode = process.argv.at(-1)
if (mode !== 'encrypt' && mode !== 'decrypt') fail('usage: backup-crypt.mjs encrypt|decrypt')
const text = process.env.BACKUP_KEY ?? ''
const secret = Buffer.from(text, 'base64url')
// Exactly a key, as the installer writes one: 32 bytes of canonical unpadded base64url.
if (secret.length !== 32 || secret.toString('base64url') !== text) fail("BACKUP_KEY isn't a key")

// BACKUP_CONTEXT names the file within its backup (`<backup id>/archive`, `<backup id>/settings`)
// and goes into the key, so a file only decrypts as itself: one backup's archive put beside
// another's settings, or a file renamed to the other, doesn't.
const context = process.env.BACKUP_CONTEXT ?? ''
if (!/^[A-Za-z0-9._/-]{0,200}$/.test(context)) fail("BACKUP_CONTEXT isn't a backup file's name")
const fileKey = (salt) =>
  Buffer.from(hkdfSync('sha256', secret, salt, context ? `trioditis backup v1 ${context}` : 'trioditis backup v1', 32))
function nonce(index, last) {
  const value = Buffer.alloc(12)
  value.writeBigUInt64BE(BigInt(index), 3)
  value[11] = last ? 1 : 0
  return value
}
function seal(key, index, last, data) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce(index, last))
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])
}
function open(key, index, last, data) {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce(index, last))
  decipher.setAuthTag(data.subarray(data.length - TAG))
  try {
    return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG)), decipher.final()])
  } catch {
    fail("the file doesn't decrypt with this BACKUP_KEY: it's another install's, damaged, or cut short")
  }
}

process.stdout.on('error', () => process.exit(1))
async function write(data) {
  if (!process.stdout.write(data)) await once(process.stdout, 'drain')
}

let buffer = Buffer.alloc(0)
let index = 0
if (mode === 'encrypt') {
  const salt = randomBytes(SALT)
  const key = fileKey(salt)
  await write(Buffer.concat([MAGIC, salt]))
  for await (const data of process.stdin) {
    buffer = Buffer.concat([buffer, data])
    // A chunk goes out only once more data follows it, so the last one is always marked last.
    while (buffer.length > CHUNK) {
      await write(seal(key, index++, false, buffer.subarray(0, CHUNK)))
      buffer = buffer.subarray(CHUNK)
    }
  }
  await write(seal(key, index, true, buffer))
} else {
  let key = null
  for await (const data of process.stdin) {
    buffer = Buffer.concat([buffer, data])
    if (key === null) {
      if (buffer.length < MAGIC.length + SALT) continue
      if (!buffer.subarray(0, MAGIC.length).equals(MAGIC)) fail("this isn't an encrypted Trioditis backup file")
      key = fileKey(buffer.subarray(MAGIC.length, MAGIC.length + SALT))
      buffer = buffer.subarray(MAGIC.length + SALT)
    }
    while (buffer.length > CHUNK + TAG) {
      await write(open(key, index++, false, buffer.subarray(0, CHUNK + TAG)))
      buffer = buffer.subarray(CHUNK + TAG)
    }
  }
  if (key === null) fail("this isn't an encrypted Trioditis backup file, or it's cut short")
  if (buffer.length < TAG)
    fail("the file doesn't decrypt with this BACKUP_KEY: it's another install's, damaged, or cut short")
  await write(open(key, index, true, buffer))
}
