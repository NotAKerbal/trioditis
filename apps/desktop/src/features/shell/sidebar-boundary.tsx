import { Button } from '@trioditis/ui/button'
import { ConvexError } from 'convex/values'
import { Component, Fragment, useEffect, type ReactNode } from 'react'
import { errorMessage } from '~/lib/errors.ts'
import { failuresInARow, retryDelay } from './retry-delay.ts'

const OFFLINE = 'Can’t reach your server. Nothing shows until it’s back; still trying.'

interface Props {
  /** Called when the list goes down, so nothing relies on what it last showed. */
  onError: () => void
  /**
   * The app opened from this device before the server confirmed the session (app-gate.tsx): an
   * error then is the server not knowing who's asking yet, not a refusal to show.
   */
  offline?: boolean
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
 * which shows an error in place of the whole app until a reload. Here only the list does,
 * and then it mounts again, which asks the server afresh: on Try again, or by itself after a
 * wait that grows while the errors keep coming.
 */
export class SidebarBoundary extends Component<Props, State> {
  override state: State = { error: undefined, attempt: 0, failures: 0, lastErrorAt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  override componentDidCatch() {
    this.props.onError()
    const now = Date.now()
    this.setState((s) => ({ failures: failuresInARow(s.failures, s.lastErrorAt, now), lastErrorAt: now }))
  }

  retry = () => this.setState((s) => ({ error: undefined, attempt: s.attempt + 1 }))

  override render() {
    const { error, attempt, failures } = this.state
    if (error === undefined) return <Fragment key={attempt}>{this.props.children}</Fragment>
    // A ConvexError is the server refusing (signed out, not a member, a label that's gone),
    // which asking again won't change; only Try again, which also clears the filters, does.
    if (this.props.offline) {
      return <ListError error={new Error(OFFLINE)} delay={retryDelay(failures)} onRetry={this.retry} />
    }
    const delay = error instanceof ConvexError ? undefined : retryDelay(failures)
    return <ListError error={error} delay={delay} onRetry={this.retry} />
  }
}

function ListError({ error, delay, onRetry }: { error: unknown; delay: number | undefined; onRetry: () => void }) {
  useEffect(() => {
    if (delay === undefined) return
    const timer = setTimeout(onRetry, delay)
    return () => clearTimeout(timer)
  }, [delay, onRetry])
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-3 text-center">
      <p role="alert" className="text-sm text-subtle-foreground">
        {errorMessage(error, 'Couldn’t load your chats.')}
      </p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  )
}
