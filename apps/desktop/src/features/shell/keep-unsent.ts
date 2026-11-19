import { useEffect } from 'react'
import { hasDrafts } from '~/data/drafts.ts'
import { desktop } from '~/lib/desktop.ts'

/**
 * In the desktop app, leaving the page while it holds unsent text (a draft, or a send not yet
 * settled) asks first: changing servers, reloading and closing the window all unload it, and
 * drafts live only in this page's memory. The app asks the question (electron/main.ts).
 */
export function useKeepUnsent() {
  useEffect(() => {
    if (!desktop) return
    const keep = (event: BeforeUnloadEvent) => {
      if (hasDrafts()) event.preventDefault()
    }
    window.addEventListener('beforeunload', keep)
    return () => window.removeEventListener('beforeunload', keep)
  }, [])
}
