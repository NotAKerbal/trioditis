// How `pnpm dev --network signal` finds libsignal: the version comes from mautrix-signal's
// source, which a fresh machine has to download first, and the library must be that version.
// A stub `go` stands in for the toolchain, answering as it does on a cold module cache.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { libsignalDir } from '../lib.mjs'

/** A stub go and a module directory it reports, holding libsignalgo's version file. */
function coldCache() {
  const top = mkdtempSync(join(tmpdir(), 'trioditis-libsignal-'))
  const module = join(top, 'mod', 'go.mau.fi', 'mautrix-signal@v0.2611.0')
  mkdirSync(join(module, 'pkg/libsignalgo/signalversion'), { recursive: true })
  writeFileSync(
    join(module, 'pkg/libsignalgo/signalversion/version.go'),
    'package signalversion\n\nconst Version = "v0.106.1"\n',
  )
  const bin = join(top, 'bin')
  mkdirSync(bin)
  // `go list -m` on a cold cache succeeds with an empty directory; `go mod download -json`
  // fetches the module and reports where it is.
  writeFileSync(
    join(bin, 'go'),
    `#!/bin/sh
case "$1 $2" in
  "list -m") echo "" ;;
  "mod download") printf '{"Path":"go.mau.fi/mautrix-signal","Version":"v0.2611.0","Dir":"%s"}\\n' '${module}' ;;
  *) echo "unexpected go $*" >&2; exit 1 ;;
esac
`,
  )
  chmodSync(join(bin, 'go'), 0o755)
  const lib = join(top, 'lib')
  mkdirSync(lib)
  return { goEnvironment: { PATH: `${bin}${delimiter}${process.env.PATH}` }, lib }
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

void test('reads the libsignal version from the module go downloads, on a cold module cache', () => {
  const { goEnvironment, lib } = coldCache()
  writeFileSync(join(lib, 'libsignal_ffi.a'), 'archive with signal_ffi_version_0_106_1 inside')
  assert.equal(
    withLibraryDir(lib, () => libsignalDir(goEnvironment)),
    lib,
  )
})

void test('names the missing library and the version it needs', () => {
  const { goEnvironment, lib } = coldCache()
  assert.throws(
    () => withLibraryDir(lib, () => libsignalDir(goEnvironment)),
    /doesn't exist\. Build libsignal v0\.106\.1/,
  )
})

void test('refuses a library of another version', () => {
  const { goEnvironment, lib } = coldCache()
  writeFileSync(join(lib, 'libsignal_ffi.a'), 'archive with signal_ffi_version_0_105_0 inside')
  assert.throws(() => withLibraryDir(lib, () => libsignalDir(goEnvironment)), /isn't libsignal v0\.106\.1/)
})
