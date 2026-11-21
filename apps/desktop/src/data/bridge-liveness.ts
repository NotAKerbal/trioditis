import { BRIDGE_HOST_STALE_MS, networkStatus, type NetworkStatus } from '@trioditis/core'
import type { LoginState } from '@trioditis/core/bridge-protocol'
import { useEffect, useRef, useState } from 'react'

// Whether a bridge host is still there. A Convex query answers again when the rows it read
// change, not as time passes, so a host that stops heartbeating (it crashed, or shut down
// without a last word) would stay "online" in the answer the page already has. A live host's
// heartbeat changes its `lastSeenAt` every 30 seconds, and the page gets each change as it
// happens, so the page times how long it has gone without a new one by its own clock. Comparing
// `lastSeenAt` itself with this clock would call a live host dead on a computer whose clock is
// a few minutes fast.

/** How often liveness is judged again while nothing else changes. */
export const LIVENESS_TICK_MS = 15_000

/** When this page first got each heartbeat time, by key (a network, or a login's host). */
export class HeardClock {
  private heard = new Map<string, { lastSeenAt: number; at: number }>()

  /** When this page first saw `lastSeenAt` for `key`, by its own clock; `now` if just now. */
  heardAt(key: string, lastSeenAt: number, now: number): number {
    const known = this.heard.get(key)
    if (known && known.lastSeenAt === lastSeenAt) return known.at
    this.heard.set(key, { lastSeenAt, at: now })
    return now
  }
}

/**
 * Whether a bridge host is up: the server thought so when it answered (`bridgeOnline`), and
 * this page has had a heartbeat from it within the last two minutes. Without a `lastSeenAt`
 * (an older server, or never heard from) the server's answer stands.
 */
export function bridgeLive(
  bridgeOnline: boolean,
  lastSeenAt: number | null | undefined,
  heardAt: number | undefined,
  now: number,
): boolean {
  if (!bridgeOnline) return false
  if (lastSeenAt == null || heardAt === undefined) return bridgeOnline
  return now - heardAt <= BRIDGE_HOST_STALE_MS
}

interface HealthRow {
  network: string
  bridgeOnline: boolean
  bridgeLastSeenAt?: number | null
  accounts: readonly { state: LoginState }[]
  status: NetworkStatus
}

/** Health rows with `bridgeOnline` and `status` judged again at `now` (see above). */
export function liveHealth<R extends HealthRow>(rows: readonly R[], clock: HeardClock, now: number): R[] {
  return rows.map((row) => {
    const heard = row.bridgeLastSeenAt == null ? undefined : clock.heardAt(row.network, row.bridgeLastSeenAt, now)
    const bridgeOnline = bridgeLive(row.bridgeOnline, row.bridgeLastSeenAt, heard, now)
    if (bridgeOnline === row.bridgeOnline) return row
    return { ...row, bridgeOnline, status: networkStatus(row.accounts, bridgeOnline) }
  })
}

/** The time, updated every `intervalMs`, so what depends on it is judged again. */
export function useNow(intervalMs = LIVENESS_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** A HeardClock that lasts as long as the component. */
export function useHeardClock(): HeardClock {
  const clock = useRef<HeardClock | null>(null)
  clock.current ??= new HeardClock()
  return clock.current
}

/** What a login step's code needs from the session, for `codeGone`. */
export interface CodeStep {
  type: string
  expiresAt?: number
  display?: { type: string; data?: string; expiresAt?: number }
}

/**
 * Why a QR or pairing code on screen can't be used any more, or null while it can: the bridge
 * host showing it has gone (`host`), or the code's time has run out (`expired`). A step's
 * `expiresAt` is bridge host time, so it's taken as how long after the step came (the
 * session's `updatedAt`, also bridge host time) and counted from when this page got the step.
 */
export function codeGone(
  step: CodeStep | null | undefined,
  timing: { updatedAt: number; stepHeardAt: number; hostOnline: boolean },
  now: number,
): 'host' | 'expired' | null {
  if (!step || step.type !== 'displayAndWait') return null
  if (!timing.hostOnline) return 'host'
  const expiresAt = step.display?.expiresAt ?? step.expiresAt
  if (expiresAt === undefined) return null
  return now >= timing.stepHeardAt + (expiresAt - timing.updatedAt) ? 'expired' : null
}
