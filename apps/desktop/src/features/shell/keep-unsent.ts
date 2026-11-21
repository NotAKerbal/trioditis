import { useEffect } from 'react'
import {
  adoptDraft,
  allDrafts,
  clearSentDraft,
  getDraft,
  hasDrafts,
  sendsInFlight,
  subscribeDrafts,
  type Draft,
} from '~/data/drafts.ts'
import { draftChatOf, draftSendId, loadDrafts, parseEntry, saveDraft } from '~/data/saved-drafts.ts'
import { useSession } from '~/lib/session.tsx'

/** How long after the last keystroke a draft is sealed and saved. */
const SAVE_AFTER_MS = 400

type Reply = { eventId: string }

/** Whether `draft` is the one sent as `clientMessageId`: same identity, reply and text. */
const isSentAs = (draft: Draft<Reply>, clientMessageId: string) =>
  !!draft.id && draftSendId(draft.id, draft.text, draft.reply?.eventId) === clientMessageId

/**
 * Keeps unsent text across a reload. Drafts are sealed to the person's own key and saved in
 * this browser, one entry per chat (saved-drafts.ts), so a reload, a crash or closing the
 * window brings them back, and nothing readable is stored. A draft sent in another tab empties
 * here too if it's still the same. Leaving still asks first, in a browser as in the desktop app
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

    // Back what was saved, as the same drafts, into chats with nothing typed yet in this page.
    if (storage) {
      for (const [chatId, draft] of loadDrafts<Reply>(storage, owner))
        adoptDraft(chatId, draft.text, draft.reply, draft.id)
    }

    // Each chat's draft as last saved from here, by revision, to save only what changed.
    const revs = new Map<string, number>()
    for (const [chatId, draft] of allDrafts()) revs.set(chatId, draft.rev)
    let timer: ReturnType<typeof setTimeout> | undefined
    // Chats changed here since the last save, emptied ones included.
    const changed = new Set<string>()
    const unsubscribe = subscribeDrafts(() => {
      for (const [chatId, draft] of allDrafts()) if (revs.get(chatId) !== draft.rev) changed.add(chatId)
      for (const chatId of revs.keys()) if (getDraft(chatId).rev !== revs.get(chatId)) changed.add(chatId)
      clearTimeout(timer)
      timer = setTimeout(save, SAVE_AFTER_MS)
    })

    function save() {
      clearTimeout(timer)
      timer = undefined
      if (!storage || !changed.size) return
      try {
        for (const chatId of [...changed]) {
          const draft = getDraft<Reply>(chatId)
          saveDraft(storage, owner, chatId, draft, draft.sent)
          revs.set(chatId, draft.rev)
          changed.delete(chatId)
        }
        saved = true
      } catch {
        saved = false
      }
    }

    // Another tab sent a draft: if this page holds the very same one, it's gone, not to go twice.
    const onStorage = (e: StorageEvent) => {
      const chatId = draftChatOf(owner.userId, e.key)
      if (!chatId) return
      const entry = parseEntry(e.newValue)
      if (!entry || !('sent' in entry)) return
      if (clearSentDraft<Reply>(chatId, (draft) => isSentAs(draft, entry.sent))) {
        // Emptied to match what's stored already: nothing of this tab's to save for it.
        revs.set(chatId, getDraft(chatId).rev)
        changed.delete(chatId)
      }
    }
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
    window.addEventListener('storage', onStorage)
    window.addEventListener('beforeunload', keep)
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      flush()
      unsubscribe()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('beforeunload', keep)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [session])
}
