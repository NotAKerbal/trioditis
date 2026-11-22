// Before a heavy run: enough disk (20 GiB kept free, plus twice what the run may write) and
// inodes where Docker keeps its data and where the report goes, and enough memory.
import { readFileSync, statfsSync } from 'node:fs'
import { freemem, totalmem } from 'node:os'
import { docker } from './stack.mjs'

const GiB = 1024 ** 3
export const RESERVE_BYTES = 20 * GiB

/** Roughly what a run writes: Postgres rows, indexes and the backend's write-ahead history. */
export function estimateBytes({ messages, chats }) {
  return 512 * 1024 ** 2 + messages * 40 * 1024 + chats * 20 * 1024
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

export function preflight({ messages, chats, outDir, minMemoryBytes = 4 * GiB, log = console.log }) {
  const need = RESERVE_BYTES + 2 * estimateBytes({ messages, chats })
  const dockerRoot = docker(['info', '--format', '{{.DockerRootDir}}'], { allowFail: true }) || '/var/lib/docker'
  const problems = []
  for (const path of new Set([dockerRoot, outDir])) {
    let r
    try {
      r = room(path, need)
    } catch {
      // Docker's root can be unreadable to us; the filesystem holding it usually is '/'.
      r = room('/', need)
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
