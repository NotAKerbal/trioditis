import type { ConvexReactClient, Watch, WatchQueryOptions } from 'convex/react'
import { getFunctionName, type FunctionReference } from 'convex/server'
import { ConvexError, convexToJson, type Value } from 'convex/values'
import { retryDelay } from '~/features/shell/retry-delay.ts'

/**
 * Whether an error is the server failing to answer rather than refusing. The backend says no
 * only with a ConvexError (signed out, not a member, a chat that's gone); anything else is a
 * function that timed out or failed on the server's side, as when a busy server runs out of
 * time for every query at once, and asking again later can succeed.
 */
export const isTransient = (error: unknown) => error instanceof Error && !(error instanceof ConvexError)

/** How long after the last failed call the server still counts as busy. */
const CALM_MS = 5_000
/** How far back this device's own count of failed calls reaches (Admin settings → Server health). */
const RECENT_MS = 5 * 60_000

/**
 * Whether calls to the server are failing now, for the one line that says so (SyncBar), and a
 * count of the recent failures this device saw. It holds times only: never what was asked.
 */
class ServerTrouble {
  /** Queries whose last answer was a failure, waiting to be asked again. */
  private failing = new Set<string>()
  private lastAt = 0
  private recent: number[] = []
  private busy = false
  private calm: ReturnType<typeof setTimeout> | undefined
  private listeners = new Set<() => void>()

  subscribe = (onChange: () => void) => {
    this.listeners.add(onChange)
    return () => void this.listeners.delete(onChange)
  }

  isBusy = () => this.busy

  /** Failed calls in the last five minutes, and when the last one was. */
  recentFailures(now = Date.now()) {
    this.recent = this.recent.filter((at) => now - at < RECENT_MS)
    return { count: this.recent.length, lastAt: this.recent.at(-1) ?? null }
  }

  failed(key?: string, now = Date.now()) {
    if (key) this.failing.add(key)
    this.lastAt = now
    this.recent.push(now)
    if (this.recent.length > 1000) this.recent.splice(0, this.recent.length - 1000)
    this.update(now)
  }

  answered(key: string, now = Date.now()) {
    if (this.failing.delete(key)) this.update(now)
  }

  forget(key: string, now = Date.now()) {
    if (this.failing.delete(key)) this.update(now)
  }

  private update(now: number) {
    clearTimeout(this.calm)
    const quietFor = now - this.lastAt
    const busy = this.failing.size > 0 || quietFor < CALM_MS
    // Calm again once nothing has failed for a while, even with no call answered meanwhile.
    if (busy && this.failing.size === 0) this.calm = setTimeout(() => this.update(Date.now()), CALM_MS - quietFor)
    if (busy === this.busy) return
    this.busy = busy
    for (const listener of this.listeners) listener()
  }
}

export const serverTrouble = new ServerTrouble()

interface Listener {
  handler: () => void
  unsubscribe: () => void
}

interface Entry {
  inner: Watch<unknown>
  listeners: Set<Listener>
  /** The last answer that came, kept while a failure is asked again. */
  lastGood: { value: unknown } | undefined
  /** The failure already counted, so each listener's notice of it doesn't count it again. */
  lastError: unknown
  failures: number
  timer: ReturnType<typeof setTimeout> | undefined
}

type Schedule = (run: () => void, ms: number) => ReturnType<typeof setTimeout>

/**
 * Keeps each query's last answer through a failure on the server's side, and asks again. A query
 * that failed stays failed: Convex runs it again only when something it read changes, which a
 * timeout gives no reason to. So every subscription to it is dropped and made again, which has
 * the server run it afresh, after a wait that grows while it keeps failing. Meanwhile whoever
 * watches it sees what it last answered, or that it's still loading, never the error, and isn't
 * told of a change: the failure isn't one. A ConvexError is the server's answer, and is passed on.
 */
export class Resubscriber {
  private entries = new Map<string, Entry>()
  private trouble: ServerTrouble
  private schedule: Schedule
  private jitter: () => number

  constructor(
    trouble: ServerTrouble = serverTrouble,
    schedule: Schedule = (run, ms) => setTimeout(run, ms),
    jitter: () => number = Math.random,
  ) {
    this.trouble = trouble
    this.schedule = schedule
    this.jitter = jitter
  }

  wrap<T>(key: string, inner: Watch<T>): Watch<T> {
    return {
      ...inner,
      onUpdate: (callback) => this.subscribe(key, inner as Watch<unknown>, callback),
      localQueryResult: () => this.result(key, inner as Watch<unknown>) as T | undefined,
    }
  }

  private subscribe(key: string, inner: Watch<unknown>, callback: () => void) {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { inner, listeners: new Set(), lastGood: undefined, lastError: undefined, failures: 0, timer: undefined }
      this.entries.set(key, entry)
    }
    const handler = () => {
      if (this.changed(key, entry)) callback()
    }
    const listener: Listener = { handler, unsubscribe: entry.inner.onUpdate(handler) }
    entry.listeners.add(listener)
    return () => {
      listener.unsubscribe()
      entry.listeners.delete(listener)
      if (entry.listeners.size > 0 || this.entries.get(key) !== entry) return
      clearTimeout(entry.timer)
      this.entries.delete(key)
      this.trouble.forget(key)
    }
  }

  /** Whether what the query shows has changed: a new answer, or the server's refusal. */
  private changed(key: string, entry: Entry): boolean {
    let value: unknown
    try {
      value = entry.inner.localQueryResult()
    } catch (error) {
      if (!isTransient(error)) return true
      this.failed(key, entry, error)
      return false
    }
    if (value === undefined) return false
    this.answered(key, entry, value)
    return true
  }

  private result(key: string, inner: Watch<unknown>): unknown {
    const entry = this.entries.get(key)
    let value: unknown
    try {
      value = inner.localQueryResult()
    } catch (error) {
      if (!isTransient(error)) throw error
      if (entry) this.failed(key, entry, error)
      return entry?.lastGood?.value
    }
    if (value === undefined) return entry?.lastGood?.value
    if (entry) this.answered(key, entry, value)
    return value
  }

  private answered(key: string, entry: Entry, value: unknown) {
    entry.lastGood = { value }
    if (entry.failures === 0) return
    entry.failures = 0
    entry.lastError = undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
    this.trouble.answered(key)
  }

  private failed(key: string, entry: Entry, error: unknown) {
    if (entry.lastError === error) return
    entry.lastError = error
    entry.failures++
    this.trouble.failed(key)
    if (entry.timer !== undefined) return
    // Spread out, so the queries that failed together aren't all asked again at the same moment.
    const wait = retryDelay(entry.failures) * (0.75 + this.jitter() / 2)
    entry.timer = this.schedule(() => this.again(key, entry), wait)
  }

  private again(key: string, entry: Entry) {
    entry.timer = undefined
    if (this.entries.get(key) !== entry || entry.listeners.size === 0) return
    // All of them first, so the query has no subscriber left and the server drops it; then each
    // again, which has it run anew.
    for (const listener of entry.listeners) listener.unsubscribe()
    for (const listener of entry.listeners) listener.unsubscribe = entry.inner.onUpdate(listener.handler)
  }
}

/**
 * The app's Convex client: queries keep their last answer through a busy server's timeouts and
 * are asked again (Resubscriber), and failed mutations and actions are counted too, for the one
 * line that says the server is busy. Nothing is sent again by itself: a mutation that failed
 * fails for its caller as before, since a send that may have gone mustn't go twice. The methods
 * are replaced on the client itself, since everything that reads queries (TanStack's adapter,
 * Convex's own hooks, the query cache) asks it for its watches.
 */
export function resilient(client: ConvexReactClient, resubscriber = new Resubscriber()): ConvexReactClient {
  const watchQuery = client.watchQuery.bind(client)
  const mutation = client.mutation.bind(client) as (...params: unknown[]) => Promise<unknown>
  const action = client.action.bind(client) as (...params: unknown[]) => Promise<unknown>
  client.watchQuery = ((query: FunctionReference<'query'>, ...rest: [Record<string, Value>?, WatchQueryOptions?]) => {
    const key = `${getFunctionName(query)}|${JSON.stringify(convexToJson((rest[0] ?? {}) as Value))}`
    return resubscriber.wrap(key, watchQuery(query, ...(rest as [])))
  }) as typeof client.watchQuery
  client.mutation = ((...params: unknown[]) => counted(mutation(...params))) as typeof client.mutation
  client.action = ((...params: unknown[]) => counted(action(...params))) as typeof client.action
  return client
}

function counted<T>(call: Promise<T>): Promise<T> {
  call.catch((error: unknown) => {
    if (isTransient(error)) serverTrouble.failed()
  })
  return call
}
