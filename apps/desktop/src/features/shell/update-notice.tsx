import { Button } from '@trioditis/ui/button'
import { useEffect, useState } from 'react'
import { useServerInfo } from '~/data/chats.ts'
import { hasDrafts } from '~/data/drafts.ts'
import { buildOutdated } from '~/data/updates.ts'

// After the server is updated, open pages move to the new web app by themselves. The server's
// version (server.info) changes the moment the new functions are deployed, which can be a few
// seconds before Caddy serves the new web app, so a page reloads only once /version.json names
// a build other than its own. While nobody's looking it reloads straight away: the page hidden,
// no draft or send under way, no settings, dialog or menu open, and nothing typed in any field
// on the page (whatever the field is for). Otherwise it offers a reload.

const BUILD: string | undefined = import.meta.env.VITE_TRIODITIS_VERSION
/** How often, and for how long, to look for the new web app once the server has a new version. */
const POLL_MS = 10_000
const POLL_TRIES = 60
/** The build this tab last reloaded itself for: a reload that still finds an old build doesn't loop. */
const RELOADED_FOR = 'trioditis.reloadedFor'

async function servedBuild(): Promise<string | null> {
  try {
    const response = await fetch('/version.json', { cache: 'no-store' })
    if (!response.ok) return null
    const { version } = (await response.json()) as { version?: unknown }
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

/**
 * Whether the page holds anything a reload would lose that the app doesn't track itself: text
 * typed in any field, or a dialog or menu open.
 */
function pageBusy() {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
  for (const field of fields) {
    if (field.readOnly || field.disabled) continue
    if (field instanceof HTMLInputElement && ['hidden', 'checkbox', 'radio', 'button', 'submit'].includes(field.type))
      continue
    if (field.value.trim()) return true
  }
  if (document.querySelector('[contenteditable="true"]:not(:empty)')) return true
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')
}

function reloadedFor() {
  try {
    return sessionStorage.getItem(RELOADED_FOR)
  } catch {
    return null
  }
}

function reload(build: string) {
  try {
    sessionStorage.setItem(RELOADED_FOR, build)
  } catch {
    // Without session storage, it only loses the guard against reloading twice.
  }
  window.location.reload()
}

export function UpdateNotice() {
  const serverVersion = useServerInfo()?.version
  const outdated = buildOutdated(BUILD, serverVersion)
  // The newer build the server serves, once it does.
  const [next, setNext] = useState<string | null>(null)

  useEffect(() => {
    setNext(null)
    if (!outdated) return
    let stopped = false
    void (async () => {
      for (let i = 0; i < POLL_TRIES && !stopped; i++) {
        const served = await servedBuild()
        if (stopped) return
        if (served && served !== 'unknown' && served !== BUILD) return setNext(served)
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    })()
    return () => {
      stopped = true
    }
  }, [outdated, serverVersion])

  useEffect(() => {
    if (!next) return
    const quietly = () => {
      const settingsOpen = new URLSearchParams(window.location.search).has('settings')
      if (
        document.visibilityState === 'hidden' &&
        !hasDrafts() &&
        !settingsOpen &&
        !pageBusy() &&
        reloadedFor() !== next
      ) {
        reload(next)
      }
    }
    quietly()
    document.addEventListener('visibilitychange', quietly)
    return () => document.removeEventListener('visibilitychange', quietly)
  }, [next])

  if (!next) return null
  return (
    <div
      role="status"
      className="fixed right-6 bottom-6 z-[60] flex h-10 items-center gap-3 rounded-[11px] bg-foreground px-4 text-sm font-medium whitespace-nowrap text-background shadow-popover"
    >
      Trioditis has been updated.
      <Button
        variant="bare"
        type="button"
        className="font-semibold text-primary-soft underline-offset-2 hover:underline"
        onClick={() => reload(next)}
      >
        Reload
      </Button>
    </div>
  )
}
