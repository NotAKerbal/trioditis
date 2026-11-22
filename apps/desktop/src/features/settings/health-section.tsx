import { api } from '@trioditis/backend/api'
import { cn } from '@trioditis/ui/lib/utils'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'
import type { FunctionReturnType } from 'convex/server'
import { useNow } from '~/data/bridge-liveness.ts'
import { networkName } from '~/data/chats.ts'
import { serverTrouble } from '~/lib/resilient-convex.ts'
import { Group, Heading, Loading, Setting } from './layout.tsx'

type Health = FunctionReturnType<typeof api.health.server>

/** An answer slower than this is the server struggling: the app's queries have a second in all. */
const SLOW_MS = 500
const HOUR_MS = 60 * 60_000

const count = new Intl.NumberFormat()
const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)

/** What the server's timing of itself says, worst news first. */
export function serverState(probes: Health['probes'], now: number) {
  const hour = probes.filter((p) => now - p.at < HOUR_MS)
  const last = hour.at(-1)
  if (!last) return { say: 'Not checked yet', warn: false, hour }
  if (!last.ok) return { say: 'Timing out', warn: true, hour }
  if (last.ms >= SLOW_MS) return { say: `Slow, ${duration(last.ms)}`, warn: true, hour }
  return { say: `Keeping up, ${duration(last.ms)}`, warn: false, hour }
}

/** How a bridge's deliveries to the server are going. */
export function bridgeState(bridge: Health['bridges'][number]) {
  if (!bridge.live) return { say: 'Offline', warn: true }
  const parts = [bridge.backlog > 0 ? `${count.format(bridge.backlog)} waiting` : 'Caught up']
  if (bridge.pushMs >= 1000) parts.push(`${duration(bridge.pushMs)} a delivery`)
  if (bridge.failedPushes > 0) parts.push(`${count.format(bridge.failedPushes)} failed`)
  return { say: parts.join(', '), warn: bridge.backlog > 300 || bridge.pushMs >= 2000 || bridge.failedPushes > 0 }
}

function State({ say, warn }: { say: string; warn: boolean }) {
  return (
    <span className={cn('shrink-0 text-sm', warn ? 'font-semibold text-warning' : 'text-muted-foreground')}>{say}</span>
  )
}

/**
 * Admin settings → Server health: whether the server is keeping up. The server times a small
 * query of its own once a minute, each bridge host says how its deliveries are going, and this
 * device counts its own calls that failed. Times and counts only.
 */
export function ServerHealth() {
  const { data, isError } = useQuery(convexQuery(api.health.server, {}))
  const now = useNow(10_000)
  const mine = serverTrouble.recentFailures(now)
  if (!data)
    return (
      <>
        <Heading title="Server health" />
        <Loading failed={isError} />
      </>
    )
  const server = serverState(data.probes, now)
  const slowest = Math.max(0, ...server.hour.map((p) => p.ms))
  const timeouts = server.hour.filter((p) => !p.ok).length
  return (
    <>
      <Heading title="Server health" />
      <Group title="Server">
        <Setting title="Answers">
          <State say={server.say} warn={server.warn} />
        </Setting>
        {server.hour.length ? (
          <>
            <Setting title="Slowest, past hour">
              <State say={duration(slowest)} warn={slowest >= SLOW_MS} />
            </Setting>
            <Setting title="Timeouts, past hour">
              <State say={count.format(timeouts)} warn={timeouts > 0} />
            </Setting>
          </>
        ) : null}
      </Group>
      {data.bridges.length ? (
        <Group title="Bridges">
          {data.bridges.map((bridge) => (
            <Setting key={`${bridge.network}/${bridge.at}`} title={networkName(bridge.network)}>
              <State {...bridgeState(bridge)} />
            </Setting>
          ))}
        </Group>
      ) : null}
      <Group title="This device">
        <Setting title="Failed calls, past 5 minutes">
          <State say={count.format(mine.count)} warn={mine.count > 0} />
        </Setting>
      </Group>
    </>
  )
}
