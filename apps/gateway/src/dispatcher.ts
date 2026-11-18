import type { BridgeCommand } from '@trioditis/core/bridge-protocol'
import type { Backend, ClaimedCommand } from './backend.ts'

// Delivers queued commands to bridge hosts. Convex leases each command to the gateway; the
// bridge host answers 202 once it has queued it durably, or 4xx if it is invalid. Anything
// else (the host is down, a timeout) leaves the command alone: its lease runs out, it is
// claimed again with the same commandId, and the bridge host runs it at most once.
// See docs/architecture/bridge-protocol.md, Commands.

export interface DispatcherOptions {
  internalToken: string
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
      (error) => this.log(`Watching for commands failed: ${error.message}`),
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
        const hosts = new Map((await this.backend.hosts()).map((host) => [host.network, host.commandAddr]))
        for (;;) {
          if (this.stopped) return
          const commands = await this.backend.claimCommands({ limit: 20 })
          if (commands.length === 0) break
          await Promise.all(commands.map((command) => this.deliver(command, hosts.get(command.network))))
        }
      } while (this.again && !this.stopped)
    } catch (error) {
      this.log(`Dispatch failed, will retry: ${String(error)}`)
    } finally {
      this.running = false
    }
  }

  private async deliver(command: ClaimedCommand, addr: string | undefined) {
    if (!addr) {
      this.log(`No ${command.network} bridge host has reported in; ${command.commandId} waits.`)
      return
    }
    const body: BridgeCommand = {
      commandId: command.commandId,
      userId: command.userId,
      ...(command.loginId ? { loginId: command.loginId } : {}),
      ...command.payload,
    } as BridgeCommand
    let response: Response
    try {
      response = await this.fetch(`${addr}/v1/commands`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.internalToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      this.log(`${command.network} bridge host unreachable for ${command.commandId}: ${String(error)}`)
      return
    }
    if (response.status === 202) {
      await this.backend.commandResult({ commandId: command.commandId, accepted: true })
    } else if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 401 &&
      response.status !== 408 &&
      response.status !== 429
    ) {
      const error = await response.text().catch(() => '')
      await this.backend.commandResult({ commandId: command.commandId, accepted: false, error: error.slice(0, 500) })
    } else {
      this.log(
        `${command.network} bridge host answered ${response.status} for ${command.commandId}; it will be retried.`,
      )
    }
  }
}
