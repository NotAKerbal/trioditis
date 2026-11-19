// How `pnpm dev --network signal` finds libsignal: the version comes from mautrix-signal's
// source (the bridge host's patched copy), and the library must be that version.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { libsignalDir } from '../lib.mjs'

/** A mautrix-signal source tree holding libsignalgo's version file, and a library directory. */
function sources() {
  const top = mkdtempSync(join(tmpdir(), 'trioditis-libsignal-'))
  const module = join(top, 'mautrix-signal')
  mkdirSync(join(module, 'pkg/libsignalgo/signalversion'), { recursive: true })
  writeFileSync(
    join(module, 'pkg/libsignalgo/signalversion/version.go'),
    'package signalversion\n\nconst Version = "v0.106.1"\n',
  )
  const lib = join(top, 'lib')
  mkdirSync(lib)
  return { module, lib }
}

function withLibraryDir(dir, fn) {
  const before = process.env.LIBSIGNAL_FFI_DIR
  process.env.LIBSIGNAL_FFI_DIR = dir
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.LIBSIGNAL_FFI_DIR
    else process.env.LIBSIGNAL_FFI_DIR = before
  }
}

void test("reads the libsignal version from mautrix-signal's source", () => {
  const { module, lib } = sources()
  writeFileSync(join(lib, 'libsignal_ffi.a'), 'archive with signal_ffi_version_0_106_1 inside')
  assert.equal(
    withLibraryDir(lib, () => libsignalDir(module)),
    lib,
  )
})

void test('names the missing library and the version it needs', () => {
  const { module, lib } = sources()
  assert.throws(() => withLibraryDir(lib, () => libsignalDir(module)), /doesn't exist\. Build libsignal v0\.106\.1/)
})

void test('refuses a library of another version', () => {
  const { module, lib } = sources()
  writeFileSync(join(lib, 'libsignal_ffi.a'), 'archive with signal_ffi_version_0_105_0 inside')
  assert.throws(() => withLibraryDir(lib, () => libsignalDir(module)), /isn't libsignal v0\.106\.1/)
})

void test("the default source is the bridge host's copy of mautrix-signal", () => {
  const { lib } = sources()
  // Whatever version the copy pins, it is read, and the missing library is named.
  assert.throws(() => withLibraryDir(lib, () => libsignalDir()), /doesn't exist\. Build libsignal v\d+\.\d+\.\d+ /)
})
