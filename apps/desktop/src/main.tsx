import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react'
import { QueryClientProvider } from '@tanstack/react-query'
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
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ConvexBetterAuthProvider>
  </StrictMode>,
)
