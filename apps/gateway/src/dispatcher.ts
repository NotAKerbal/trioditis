import type { BridgeCommand } from '@trioditis/core/bridge-protocol'
import type { Backend, ClaimedCommand } from './backend.ts'
import { describeError } from './log.ts'

// Delivers queued commands to bridge hosts. Convex leases each command to the gateway and
// names the bridge host it goes to; the gateway looks that host's address up in its own
// configuration, never in anything a host reported. The host answers 202 once it has queued
// the command durably, or 4xx with an error code if it is invalid. Anything else (the host is
// down, a timeout) leaves the command alone: its lease runs out and it is delivered again,
// to the same host, with the same commandId, and the host runs it at most once.
// See docs/architecture/bridge-protocol.md, Commands.

const ERROR_CODE = /^[a-z_]{1,40}$/

export interface DispatcherOptions {
  internalToken: string
  bridgeHosts: Map<string, string>
  /** How often to look again even if nothing changed, for commands whose lease ran out. */
  sweepMs?: number
  fetch?: typeof fetch
  log?: (message: string) => void
}

export class Dispatcher {
  private running = false
  private again = false
  private stopped = false
  private unsubscribe: (() => void) | null = null
  private sweep: ReturnType<typeof setInterval> | null = null
  private readonly backend: Backend
  private readonly options: DispatcherOptions
  private readonly fetch: typeof fetch
  private readonly log: (message: string) => void

  constructor(backend: Backend, options: DispatcherOptions) {
    this.backend = backend
    this.options = options
    this.fetch = options.fetch ?? fetch
    this.log = options.log ?? ((message) => console.log(message))
  }

  start() {
    // A failing subscription (the backend is down, or the secret is wrong) must not stop the
    // gateway: the sweep below keeps trying, and logs why it can't claim.
    this.unsubscribe = this.backend.watchPendingCommands(
      () => void this.drain(),
      (error) => this.log(`Watching for commands failed: ${describeError(error)}`),
    )
    this.sweep = setInterval(() => void this.drain(), this.options.sweepMs ?? 10_000)
    void this.drain()
  }

  stop() {
    this.stopped = true
    this.unsubscribe?.()
    if (this.sweep) clearInterval(this.sweep)
  }

  /** Claims and delivers until nothing is left. Overlapping calls collapse into one more pass. */
  async drain(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      do {
        this.again = false
        for (;;) {
          if (this.stopped) return
          const commands = await this.backend.claimCommands({ limit: 20 })
          if (commands.length === 0) break
          await Promise.all(commands.map((command) => this.deliver(command)))
        }
      } while (this.again && !this.stopped)
    } catch (error) {
      this.log(`Dispatch failed, will retry: ${describeError(error)}`)
    } finally {
      this.running = false
    }
  }

  private async deliver(command: ClaimedCommand) {
    const addr = this.options.bridgeHosts.get(command.hostId)
    if (!addr) {
      this.log(`Bridge host ${command.hostId} isn't in BRIDGE_HOSTS; ${command.commandId} waits.`)
      return
    }
    const body = {
      commandId: command.commandId,
      userId: command.userId,
      ...(command.loginId ? { loginId: command.loginId } : {}),
      ...command.payload,
      ...(command.sealed ? { sealed: command.sealed } : {}),
      ...(command.notAfter !== undefined ? { notAfter: command.notAfter } : {}),
    } as BridgeCommand
    let response: Response
    try {
      response = await this.fetch(`${addr}/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.internalToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // The token goes to the configured address and nowhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      this.log(`Bridge host ${command.hostId} unreachable for ${command.commandId}: ${describeError(error)}`)
      return
    }
    const { commandId, lease } = command
    if (response.status === 202) {
      await this.backend.commandResult({ commandId, lease, accepted: true })
      return
    }
    const retryable = response.status === 401 || response.status === 408 || response.status === 429
    if (response.status >= 400 && response.status < 500 && !retryable) {
      await this.backend.commandResult({ commandId, lease, accepted: false, error: await errorCode(response) })
      return
    }
    this.log(`Bridge host ${command.hostId} answered ${response.status} for ${commandId}; it will be retried.`)
  }
}

/** The error code in a bridge host's 4xx body. Anything else becomes `invalid_command`. */
async function errorCode(response: Response) {
  try {
    const { error } = (await response.json()) as { error?: unknown }
    if (typeof error === 'string' && ERROR_CODE.test(error)) return error as never
  } catch {
    // Not JSON: nothing to keep.
  }
  return 'invalid_command' as const
}
