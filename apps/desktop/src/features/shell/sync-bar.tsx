import { cn } from '@trioditis/ui/lib/utils'
import { useSyncExternalStore } from 'react'
import { convex } from '~/lib/convex.ts'

const subscribe = (onChange: () => void) => convex.subscribeToConnectionState(onChange)
const connected = () => convex.connectionState().isWebSocketConnected

/** Whether the app is connected to its server now; while it isn't, everything shown is the cache's. */
export function useConnected() {
  return useSyncExternalStore(subscribe, connected)
}

/**
 * A thin line along the bottom edge of the bar it's in (which must be `relative`), moving while
 * what's under it is the cache's copy and the server's answer is on its way: amber, and still,
 * while the server can't be reached at all. It takes no room, so nothing moves when it comes or
 * goes, and it waits a moment first, so an answer that comes quickly never shows it.
 */
export function SyncBar({ active, offline = false }: { active: boolean; offline?: boolean }) {
  if (!active) return null
  return (
    <span
      role="status"
      title={offline ? 'Can’t reach your server. Showing what was last loaded.' : 'Updating'}
      className="pointer-events-auto absolute inset-x-0 -bottom-px h-0.5 animate-fade-in-late overflow-hidden"
    >
      <span className="sr-only">{offline ? 'Can’t reach your server. Showing what was last loaded.' : 'Updating'}</span>
      <span
        className={cn(
          'block h-full',
          offline
            ? 'w-full bg-warning'
            : 'w-1/3 animate-sync bg-primary motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-60',
        )}
      />
    </span>
  )
}
