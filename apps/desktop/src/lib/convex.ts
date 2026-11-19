import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { ConvexReactClient } from 'convex/react'
import { config } from './config.ts'

// One Convex client for the app, shared by TanStack Query: queries are live subscriptions,
// and `useQuery(convexQuery(api.x.y, args))` re-renders when the data changes.
export const convex = new ConvexReactClient(config.convexUrl, { expectAuth: true })
export const convexQueryClient = new ConvexQueryClient(convex)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      queryFn: convexQueryClient.queryFn(),
    },
  },
})
convexQueryClient.connect(queryClient)
