import { ConvexQueryClient } from '@convex-dev/react-query'
import { QueryClient } from '@tanstack/react-query'
import { CONVEX_URL } from './env.ts'

// One Convex client for the app, shared by TanStack Query: queries are live subscriptions,
// and `useQuery(convexQuery(api.x.y, args))` re-renders when the data changes.
export const convexQueryClient = new ConvexQueryClient(CONVEX_URL, { expectAuth: true })

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      queryFn: convexQueryClient.queryFn(),
    },
  },
})
convexQueryClient.connect(queryClient)

export const convex = convexQueryClient.convexClient
