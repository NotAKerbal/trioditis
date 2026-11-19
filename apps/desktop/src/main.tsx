import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache/provider'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Every tab follows sign-ins and sign-outs in the others (lib/account-tabs.ts).
import './lib/account-tabs.ts'
import { authClient } from './lib/auth-client.ts'
import { convex, queryClient } from './lib/convex.ts'
import { applyTheme } from './lib/prefs.ts'
import { routeTree } from './routeTree.gen.ts'
import './styles/app.css'

const router = createRouter({ routeTree, defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

applyTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      {/* Recently left chats stay subscribed, so reopening one is instant (data/messages.ts).
          Bounded, since each idle one is still a live query on the server; signing out loads
          a new page, so none outlives the account. */}
      <ConvexQueryCacheProvider expiration={5 * 60_000} maxIdleEntries={20}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ConvexQueryCacheProvider>
    </ConvexBetterAuthProvider>
  </StrictMode>,
)
