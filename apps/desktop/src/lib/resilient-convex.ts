import type { ConvexReactClient, Watch, WatchQueryOptions } from 'convex/react'
import type { QueryJournal } from 'convex/browser'
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
/** How far back this device's own count of failed calls reaches (Settings → Admin → Server health). */
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

  /**
   * A call failed. Counted for this device either way; it makes the server busy only when it's
   * one something on screen waits for (`shown`), not a page kept warm for later.
   */
  failed(key?: string, shown = true, now = Date.now()) {
    this.recent.push(now)
    if (this.recent.length > 1000) this.recent.splice(0, this.recent.length - 1000)
    if (!shown) return
    if (key) this.failing.add(key)
    this.lastAt = now
    this.update(now)
  }

  /** A query that had failed is wanted on screen again, and is being asked again. */
  waiting(key: string, now = Date.now()) {
    if (this.failing.has(key)) return
    this.failing.add(key)
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
  callback: () => void
  /** A subscription only kept warm (the query cache, TanStack's), not one anything shows. */
  passive: boolean
}

/** A watch of the same query made again, carrying on from a journal (a paginated query's end cursor). */
type Remake = (journal: QueryJournal) => Watch<unknown>

interface Entry {
  inner: Watch<unknown>
  remake: Remake | undefined
  /** The one subscription to the server, shared by every listener, and what it calls. */
  unsubscribe: (() => void) | undefined
  handler: () => void
  /**
   * The journal of the last answer. A paginated query's page keeps where it ends in its journal;
   * asked again without it, a page could end elsewhere, leaving a gap before the next page.
   */
  journal: QueryJournal | undefined
  listeners: Set<Listener>
  /** The last answer that came, kept while a failure is asked again. */
  lastGood: { value: unknown } | undefined
  failures: number
  timer: ReturnType<typeof setTimeout> | undefined
}

type Schedule = (run: () => void, ms: number) => ReturnType<typeof setTimeout>

/**
 * Keeps each query's last answer through a failure on the server's side, and asks again. A query
 * that failed stays failed: Convex runs it again only when something it read changes, which a
 * timeout gives no reason to. So its subscription is dropped and made again, which has the server
 * run it afresh, after a wait that grows while it keeps failing. Meanwhile whoever watches it sees
 * what it last answered, or that it's still loading, never the error, and isn't told of a change:
 * the failure isn't one. A ConvexError is the server's answer, and is passed on.
 *
 * Each query has one subscription, whatever watches it, so each answer is looked at once. Only a
 * query something on screen wants is asked again: one only kept warm for later (`passive`, with
 * no `demand`) waits, so it doesn't compete with what the person is looking at, until it's wanted.
 */
export class Resubscriber {
  private entries = new Map<string, Entry>()
  /** TanStack observers per query: what TanStack's own (passive) subscription is kept for. */
  private demanded = new Map<string, number>()
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

  wrap<T>(key: string, inner: Watch<T>, remake?: (journal: QueryJournal) => Watch<T>, passive = false): Watch<T> {
    return {
      ...inner,
      onUpdate: (callback) =>
        this.subscribe(key, inner as Watch<unknown>, remake as Remake | undefined, callback, passive),
      localQueryResult: () => this.result(key, inner as Watch<unknown>) as T | undefined,
    }
  }

  /** Something on screen now wants (+1) or no longer wants (-1) this query. */
  demand(key: string, change: 1 | -1) {
    const count = (this.demanded.get(key) ?? 0) + change
    if (count > 0) this.demanded.set(key, count)
    else this.demanded.delete(key)
    const entry = this.entries.get(key)
    if (entry) this.wantChanged(key, entry)
  }

  private wanted(key: string, entry: Entry) {
    if ((this.demanded.get(key) ?? 0) > 0) return true
    for (const listener of entry.listeners) if (!listener.passive) return true
    return false
  }

  /** A failed query is asked again once it's wanted, and left alone while it isn't. */
  private wantChanged(key: string, entry: Entry) {
    if (entry.failures === 0) return
    if (!this.wanted(key, entry)) {
      clearTimeout(entry.timer)
      entry.timer = undefined
      this.trouble.forget(key)
    } else if (entry.timer === undefined) {
      this.trouble.waiting(key)
      this.retryLater(key, entry)
    }
  }

  private subscribe(
    key: string,
    inner: Watch<unknown>,
    remake: Remake | undefined,
    callback: () => void,
    passive: boolean,
  ) {
    let entry = this.entries.get(key)
    if (!entry) {
      const fresh: Entry = {
        inner,
        remake,
        unsubscribe: undefined,
        handler: () => {
          if (!this.changed(key, fresh)) return
          // A copy: a callback may stop listening.
          for (const listener of Array.from(fresh.listeners)) listener.callback()
        },
        journal: undefined,
        listeners: new Set(),
        lastGood: undefined,
        failures: 0,
        timer: undefined,
      }
      entry = fresh
      this.entries.set(key, entry)
    }
    const listener: Listener = { callback, passive }
    entry.listeners.add(listener)
    entry.unsubscribe ??= entry.inner.onUpdate(entry.handler)
    if (!passive) this.wantChanged(key, entry)
    const owner = entry
    return () => {
      if (!owner.listeners.delete(listener)) return
      if (owner.listeners.size > 0) return this.wantChanged(key, owner)
      owner.unsubscribe?.()
      clearTimeout(owner.timer)
      if (this.entries.get(key) === owner) this.entries.delete(key)
      this.trouble.forget(key)
    }
  }

  /** Whether what the query shows has changed: a new answer, or the server's refusal. */
  private changed(key: string, entry: Entry): boolean {
    let value: unknown
    try {
      value = entry.inner.localQueryResult()
    } catch (error) {
      if (!isTransient(error)) {
        this.refused(key, entry)
        return true
      }
      this.failed(key, entry)
      return false
    }
    if (value === undefined) return false
    this.answered(key, entry, value)
    return true
  }

  /**
   * What a reader sees. Failures are counted only as they arrive (`changed`), once each: Convex
   * makes a new error each time a failed answer is read.
   */
  private result(key: string, inner: Watch<unknown>): unknown {
    const entry = this.entries.get(key)
    let value: unknown
    try {
      value = inner.localQueryResult()
    } catch (error) {
      if (!isTransient(error)) throw error
      return entry?.lastGood?.value
    }
    return value === undefined ? entry?.lastGood?.value : value
  }

  private answered(key: string, entry: Entry, value: unknown) {
    entry.lastGood = { value }
    entry.journal = entry.inner.journal() ?? entry.journal
    this.settled(key, entry)
  }

  /**
   * The server said no: that's its answer, not a failure to ask again. What it showed before
   * mustn't come back through a later timeout either.
   */
  private refused(key: string, entry: Entry) {
    entry.lastGood = undefined
    this.settled(key, entry)
  }

  private settled(key: string, entry: Entry) {
    if (entry.failures === 0 && entry.timer === undefined) return
    entry.failures = 0
    clearTimeout(entry.timer)
    entry.timer = undefined
    this.trouble.answered(key)
  }

  private failed(key: string, entry: Entry) {
    entry.failures++
    const wanted = this.wanted(key, entry)
    this.trouble.failed(key, wanted)
    if (wanted && entry.timer === undefined) this.retryLater(key, entry)
  }

  private retryLater(key: string, entry: Entry) {
    // Spread out, so the queries that failed together aren't all asked again at the same moment.
    const wait = retryDelay(Math.max(1, entry.failures)) * (0.75 + this.jitter() / 2)
    entry.timer = this.schedule(() => this.again(key, entry), wait)
  }

  private again(key: string, entry: Entry) {
    entry.timer = undefined
    if (this.entries.get(key) !== entry || !entry.unsubscribe || !this.wanted(key, entry)) return
    // Dropped first, so the query has no subscriber left and the server lets it go; then made
    // again, which has it run anew, from where its last answer left off.
    entry.unsubscribe()
    if (entry.journal !== undefined && entry.remake) entry.inner = entry.remake(entry.journal)
    entry.unsubscribe = entry.inner.onUpdate(entry.handler)
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
export function resilient(client: ConvexReactClient, resubscriber = new Resubscriber()) {
  const watchQuery = client.watchQuery.bind(client) as (
    query: FunctionReference<'query'>,
    args?: Record<string, Value>,
    options?: WatchQueryOptions,
  ) => Watch<unknown>
  const mutation = client.mutation.bind(client) as (...params: unknown[]) => Promise<unknown>
  const action = client.action.bind(client) as (...params: unknown[]) => Promise<unknown>
  const watch = (passive: boolean) =>
    ((query: FunctionReference<'query'>, args?: Record<string, Value>, options?: WatchQueryOptions) =>
      resubscriber.wrap(
        queryKey(query, args),
        watchQuery(query, args, options),
        (journal) => watchQuery(query, args, { ...options, journal }),
        passive,
      )) as typeof client.watchQuery
  client.watchQuery = watch(false)
  const countedMutation = ((...params: unknown[]) => counted(mutation(...params))) as typeof client.mutation
  const countedAction = ((...params: unknown[]) => counted(action(...params))) as typeof client.action
  client.mutation = countedMutation
  client.action = countedAction
  const passiveWatch = watch(true)
  // As ConvexReactClient.query, through the passive watch, and given up when `signal` aborts.
  const warmQuery = (
    query: FunctionReference<'query'> | string,
    args?: Record<string, Value>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const one = passiveWatch(query as FunctionReference<'query'>, args ?? {})
    const existing = one.localQueryResult()
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      // A fetch that failed waits to be asked again while it's wanted; once nothing wants it
      // (TanStack cancels it), it lets its subscription go rather than hold it for good.
      const abandon = () => {
        stop()
        reject(signal?.reason ?? new Error('Cancelled'))
      }
      const stop = one.onUpdate(() => {
        stop()
        signal?.removeEventListener('abort', abandon)
        try {
          resolve(one.localQueryResult())
        } catch (error) {
          reject(error)
        }
      })
      if (signal?.aborted) abandon()
      else signal?.addEventListener('abort', abandon, { once: true })
    })
  }
  /**
   * The same client for what only keeps queries warm (the query cache, TanStack's adapter): its
   * subscriptions are asked again after a failure only once something on screen wants them
   * (`demand`, for TanStack's observers).
   */
  const passive = {
    url: client.url,
    watchQuery: passiveWatch,
    action: countedAction,
    mutation: countedMutation,
    query: warmQuery as unknown as typeof client.query,
  } as unknown as ConvexReactClient
  return { client, passive, warmQuery, demand: (key: string, change: 1 | -1) => resubscriber.demand(key, change) }
}

/** A query's key, as Convex knows it: its name and arguments. */
export function queryKey(query: FunctionReference<'query'> | string, args?: Record<string, Value>) {
  return `${getFunctionName(query as FunctionReference<'query'>)}|${JSON.stringify(convexToJson((args ?? {}) as Value))}`
}

function counted<T>(call: Promise<T>): Promise<T> {
  call.catch((error: unknown) => {
    if (isTransient(error)) serverTrouble.failed()
  })
  return call
}
