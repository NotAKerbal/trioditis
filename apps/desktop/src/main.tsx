import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ConvexQueryCacheProvider } from 'convex-helpers/react/cache/provider'
import { ConvexProvider } from 'convex/react'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
// Every tab follows sign-ins and sign-outs in the others (lib/account-tabs.ts).
import './lib/account-tabs.ts'
import { authClient } from './lib/auth-client.ts'
import { useAuthEpoch } from './lib/auth-epoch.ts'
import { convex, queryClient, warmConvex } from './lib/convex.ts'
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

/**
 * The Convex auth provider, started afresh when the gate finds Better Auth signed in but Convex
 * not, after the server was away (lib/auth-epoch.ts): it asks for a token once per session.
 */
function AuthProvider({ children }: { children: ReactNode }) {
  const epoch = useAuthEpoch()
  return (
    <ConvexBetterAuthProvider key={epoch} client={convex} authClient={authClient}>
      {children}
    </ConvexBetterAuthProvider>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      {/* A query nothing shows any more, such as a left chat's pages of messages
          (data/messages.ts), stays subscribed for 5 minutes, so reopening the chat is instant.
          Each idle one is still a live query on the server, so their number is capped too. The
          cap counts queries, so each loaded page counts, not chats. Once it's reached, the
          library drops the query that has just gone idle, not the oldest, so it's set well
          above a working session's worth: the 5 minutes are what bound it in practice. Signing
          out loads a new page, so none outlives the account. */}
      {/* The cache holds its subscriptions through the warm client, so one a failure left waiting
          is asked again only once a page that shows it watches it too (lib/resilient-convex.ts);
          everything inside uses the app's own client. */}
      <ConvexProvider client={warmConvex}>
        <ConvexQueryCacheProvider expiration={5 * 60_000} maxIdleEntries={100}>
          <ConvexProvider client={convex}>
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </ConvexProvider>
        </ConvexQueryCacheProvider>
      </ConvexProvider>
    </AuthProvider>
  </StrictMode>,
)
