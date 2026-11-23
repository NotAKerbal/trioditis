// Before a heavy run: enough disk (20 GiB kept free, plus twice what the run may write) and
// inodes where Docker keeps its data and where the report goes, and enough memory. The 20 GiB
// is what a shared machine keeps for everyone else; a throwaway CI runner can keep less
// (LOAD_DISK_RESERVE_GIB).
import { readFileSync, statfsSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { composeImage, docker } from './stack.mjs'

const GiB = 1024 ** 3
export const RESERVE_BYTES = 20 * GiB

export function reserveBytes(env = process.env) {
  const gib = env.LOAD_DISK_RESERVE_GIB === undefined ? 20 : Number(env.LOAD_DISK_RESERVE_GIB)
  if (!Number.isFinite(gib) || gib < 0) throw new Error('LOAD_DISK_RESERVE_GIB must be a number of GiB.')
  return gib * GiB
}

/**
 * Roughly what a run writes: Postgres rows, indexes and the backend's write-ahead history, for
 * the seeded inbox and for what's written while measured (every live message comes with typing,
 * reactions and receipts), plus the images if they aren't pulled yet.
 */
export function estimateBytes({ messages, chats, minutes = 0, perMinute = 0 }) {
  return GiB + messages * 40 * 1024 + chats * 20 * 1024 + minutes * perMinute * 3 * 40 * 1024
}

function available() {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8')
    const kb = Number(info.match(/^MemAvailable:\s+(\d+)/m)?.[1])
    if (kb) return kb * 1024
  } catch {}
  return freemem()
}

/** Whether a filesystem has room: `{ ok, freeBytes, needBytes, inodesFree }`. */
export function room(path, needBytes, stat = statfsSync) {
  const s = stat(path)
  const freeBytes = Number(s.bavail) * Number(s.bsize)
  const inodesFree = s.files > 0 ? Number(s.ffree) / Number(s.files) : 1
  return { path, ok: freeBytes >= needBytes && inodesFree >= 0.1, freeBytes, needBytes, inodesFree }
}

/**
 * The room on the filesystem that holds Docker's data, asked of Docker when this process can't
 * look itself (it is often root's alone): `df` in a throwaway container with it mounted.
 */
function dockerRoom(root, needBytes) {
  const out = docker(
    [
      'run',
      '--rm',
      '--entrypoint',
      'sh',
      '-v',
      `${root}:/probe:ro`,
      composeImage('postgres'),
      '-c',
      'df -Pk /probe; df -Pi /probe',
    ],
    { allowFail: true },
  )
  const rows = out.split('\n').filter((line) => line.includes('/probe'))
  if (rows.length < 2) return null
  const [, , , availKb] = rows[0].trim().split(/\s+/)
  const [, inodes, , inodesFree] = rows[1].trim().split(/\s+/)
  const freeBytes = Number(availKb) * 1024
  const share = Number(inodes) > 0 ? Number(inodesFree) / Number(inodes) : 1
  if (!Number.isFinite(freeBytes)) return null
  return { path: root, ok: freeBytes >= needBytes && share >= 0.1, freeBytes, needBytes, inodesFree: share }
}

export function preflight({
  messages,
  chats,
  minutes,
  perMinute,
  outDir,
  minMemoryBytes = 4 * GiB,
  log = console.log,
}) {
  const need = reserveBytes() + 2 * estimateBytes({ messages, chats, minutes, perMinute })
  const dockerRoot = docker(['info', '--format', '{{.DockerRootDir}}'], { allowFail: true })
  const problems = []
  if (!dockerRoot) problems.push("Docker didn't say where it keeps its data (docker info)")
  for (const path of new Set([dockerRoot, outDir].filter(Boolean))) {
    let r
    try {
      r = room(path, need)
    } catch {
      r = path === dockerRoot ? dockerRoom(path, need) : null
    }
    if (!r) {
      problems.push(`couldn't find how much room ${path} has`)
      continue
    }
    log(
      `Disk at ${r.path}: ${(r.freeBytes / GiB).toFixed(1)} GiB free, need ${(need / GiB).toFixed(1)} GiB; ${(r.inodesFree * 100).toFixed(0)}% inodes free`,
    )
    if (!r.ok)
      problems.push(
        `${r.path} has ${(r.freeBytes / GiB).toFixed(1)} GiB free and ${(r.inodesFree * 100).toFixed(0)}% inodes; the run needs ${(need / GiB).toFixed(1)} GiB and 10%`,
      )
  }
  const mem = available()
  log(`Memory: ${(mem / GiB).toFixed(1)} GiB available of ${(totalmem() / GiB).toFixed(1)} GiB`)
  if (mem < minMemoryBytes)
    problems.push(
      `only ${(mem / GiB).toFixed(1)} GiB of memory is available; the run needs ${(minMemoryBytes / GiB).toFixed(0)} GiB`,
    )
  if (problems.length) throw new Error(`Not starting the load test:\n  - ${problems.join('\n  - ')}`)
}
