import { useEffect } from 'react'
import {
  allDrafts,
  getDraft,
  hasDrafts,
  sendsInFlight,
  setDraftReply,
  setDraftText,
  subscribeDrafts,
} from '~/data/drafts.ts'
import { loadDrafts, saveDrafts, type SavedDraft } from '~/data/saved-drafts.ts'
import { useSession } from '~/lib/session.tsx'

/** How long after the last keystroke a draft is sealed and saved. */
const SAVE_AFTER_MS = 400

/**
 * Keeps unsent text across a reload. Drafts are sealed to the person's own key and saved in
 * this browser (saved-drafts.ts), so a reload, a crash or closing the window brings them back,
 * and nothing readable is stored. Leaving still asks first, in a browser as in the desktop app
 * (electron/main.ts asks there), while a send is on its way, since its text is then in neither
 * the draft nor the server; and for any draft if this browser refused to save it.
 */
export function useKeepUnsent() {
  const session = useSession()

  useEffect(() => {
    const owner = { userId: session.userId, keyPair: session.keyPair }
    let storage: Storage | null = null
    try {
      storage = window.localStorage
    } catch {
      // Storage blocked: drafts stay in memory, and leaving asks first.
    }
    let saved = storage !== null

    // Back what was saved, into chats with nothing typed yet in this page.
    if (storage) {
      for (const [chatId, draft] of loadDrafts(storage, owner)) {
        const now = getDraft(chatId)
        if (now.text.trim() || now.reply) continue
        setDraftText(chatId, draft.text)
        if (draft.reply) setDraftReply(chatId, draft.reply)
      }
    }

    // Each chat's draft as last saved from here, by revision, to save only what changed.
    const revs = new Map<string, number>()
    for (const [chatId, draft] of allDrafts()) revs.set(chatId, draft.rev)
    let timer: ReturnType<typeof setTimeout> | undefined

    function save() {
      clearTimeout(timer)
      timer = undefined
      if (!storage) return
      const now = new Map(allDrafts())
      const changed = new Set<string>()
      for (const [chatId, draft] of now) if (revs.get(chatId) !== draft.rev) changed.add(chatId)
      // Emptied (sent, or cleared): its saved copy goes.
      for (const chatId of revs.keys()) if (!now.has(chatId)) changed.add(chatId)
      if (!changed.size) return
      try {
        saveDrafts<unknown>(storage, owner, changed, new Map([...now].map(([id, d]) => [id, d as SavedDraft<unknown>])))
        revs.clear()
        for (const [chatId, draft] of now) revs.set(chatId, draft.rev)
        saved = true
      } catch {
        saved = false
      }
    }

    const unsubscribe = subscribeDrafts(() => {
      clearTimeout(timer)
      timer = setTimeout(save, SAVE_AFTER_MS)
    })
    const flush = () => {
      if (timer !== undefined) save()
    }
    const keep = (event: BeforeUnloadEvent) => {
      flush()
      if (sendsInFlight() || (!saved && hasDrafts())) event.preventDefault()
    }
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('beforeunload', keep)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      flush()
      unsubscribe()
      window.removeEventListener('beforeunload', keep)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [session])
}
