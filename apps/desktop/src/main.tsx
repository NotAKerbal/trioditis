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
      {/* A query nothing shows any more, such as a left chat's pages of messages
          (data/messages.ts), stays subscribed for 5 minutes, so reopening the chat is instant.
          Each idle one is still a live query on the server, so their number is capped too. The
          cap counts queries, so each loaded page counts, not chats. Once it's reached, the
          library drops the query that has just gone idle, not the oldest, so it's set well
          above a working session's worth: the 5 minutes are what bound it in practice. Signing
          out loads a new page, so none outlives the account. */}
      <ConvexQueryCacheProvider expiration={5 * 60_000} maxIdleEntries={100}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ConvexQueryCacheProvider>
    </ConvexBetterAuthProvider>
  </StrictMode>,
)
