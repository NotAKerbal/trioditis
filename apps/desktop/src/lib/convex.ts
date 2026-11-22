import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { ConvexReactClient } from 'convex/react'
import type { Value } from 'convex/values'
import { config } from './config.ts'
import { queryKey, resilient } from './resilient-convex.ts'

// One Convex client for the app, shared by TanStack Query: queries are live subscriptions,
// and `useQuery(convexQuery(api.x.y, args))` re-renders when the data changes. A query the
// server fails to answer keeps its last answer and is asked again (lib/resilient-convex.ts).
const app = resilient(new ConvexReactClient(config.convexUrl, { expectAuth: true }))
export const convex = app.client
/**
 * The client for what only keeps queries warm: the query cache (main.tsx) and TanStack's adapter,
 * which keeps a query subscribed for minutes after nothing shows it. After a failure, such a
 * query is asked again only while something on screen wants it.
 */
export const warmConvex = app.passive
export const convexQueryClient = new ConvexQueryClient(warmConvex)

const convexQueryFn = convexQueryClient.queryFn()
const { warmQuery } = app

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      // The adapter's, with TanStack's signal passed on: a first fetch that failed, and that
      // nothing wants any more, is cancelled and lets its subscription go.
      queryFn: (context) => {
        const [kind, name, args] = context.queryKey as [unknown, string, Record<string, Value> | 'skip']
        if (kind === 'convexQuery' && args !== 'skip') return warmQuery(name, args, context.signal)
        return convexQueryFn(context)
      },
    },
  },
})
convexQueryClient.connect(queryClient)

// What TanStack's observers want is what its (warm) subscriptions are asked again for.
queryClient.getQueryCache().subscribe((event) => {
  if (event.type !== 'observerAdded' && event.type !== 'observerRemoved') return
  const [kind, name, args] = event.query.queryKey as [unknown, string, Record<string, Value> | 'skip']
  if (kind !== 'convexQuery' || args === 'skip') return
  app.demand(queryKey(name, args), event.type === 'observerAdded' ? 1 : -1)
})
