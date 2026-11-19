import { Outlet, createRootRoute } from '@tanstack/react-router'
import { Toaster } from '@trioditis/ui/toast'

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Toaster />
    </>
  ),
})
