import { Button } from '@trioditis/ui/button'
import { Component, Fragment, useEffect, type ReactNode } from 'react'
import { errorMessage } from '~/lib/errors.ts'
import { failuresInARow, retryDelay } from './retry-delay.ts'

interface Props {
  /** Shown under the error too, so Settings stays in reach while the list is down. */
  bottomBar: ReactNode
  children: ReactNode
}

interface State {
  error: unknown
  /** Bumped on each retry: the sidebar mounts again under a new key. */
  attempt: number
  /** Errors in a row, for the wait before the next retry. */
  failures: number
  lastErrorAt: number
}

/**
 * Keeps the app up when the chat list can't load. `usePaginatedQuery` throws a page that
 * failed, most often one a busy server timed out, and past this it would reach the router,
 * which shows an error in place of the whole app until a reload. Here only the sidebar does,
 * and then it mounts again, which asks the server afresh: on Try again, or by itself after a
 * wait that grows while the errors keep coming.
 */
export class SidebarBoundary extends Component<Props, State> {
  override state: State = { error: undefined, attempt: 0, failures: 0, lastErrorAt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  override componentDidCatch() {
    const now = Date.now()
    this.setState((s) => ({ failures: failuresInARow(s.failures, s.lastErrorAt, now), lastErrorAt: now }))
  }

  retry = () => this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }))

  override render() {
    const { error, attempt, failures } = this.state
    if (error === undefined) return <Fragment key={attempt}>{this.props.children}</Fragment>
    return (
      <aside className="flex w-[332px] shrink-0 flex-col border-r border-border bg-rail" aria-label="Chats">
        <ListError error={error} delay={retryDelay(failures)} onRetry={this.retry} />
        <div className="flex h-[52px] shrink-0 items-center gap-1 border-t border-border px-2.5">
          {this.props.bottomBar}
        </div>
      </aside>
    )
  }
}

function ListError({ error, delay, onRetry }: { error: unknown; delay: number; onRetry: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onRetry, delay)
    return () => clearTimeout(timer)
  }, [delay, onRetry])
  return (
    <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-3 text-center">
      <p className="text-sm text-subtle-foreground">{errorMessage(error, 'Couldn’t load your chats.')}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  )
}
