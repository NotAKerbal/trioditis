import { useEffect } from 'react'
import {
  adoptDraft,
  allDrafts,
  allHeld,
  allSending,
  clearSentDraft,
  getDraft,
  hasDrafts,
  holdDraft,
  onDraftSent,
  sendsInFlight,
  subscribeDrafts,
  type Draft,
} from '~/data/drafts.ts'
import {
  draftSendId,
  keyOf,
  loadAll,
  parseSent,
  removeDraftIfOurs,
  removeSending,
  writeDraft,
  writeHeld,
  writeSending,
  writeSent,
} from '~/data/saved-drafts.ts'
import { useSession } from '~/lib/session.tsx'

/** How long after the last keystroke a draft is sealed and saved. */
const SAVE_AFTER_MS = 400

type Reply = { eventId: string }

const sendIdOf = (d: { id: string; text: string; reply: Reply | null }) => draftSendId(d.id, d.text, d.reply?.eventId)

/** Whether `draft` is the one sent as `clientMessageId`: same identity, reply and text. */
const isSentAs = (draft: Draft<Reply>, clientMessageId: string) => !!draft.id && sendIdOf(draft) === clientMessageId

/**
 * Keeps unsent text across a reload. Drafts, sends under way and held messages are sealed to
 * the person's own key and saved in this browser, per chat (saved-drafts.ts), so a reload, a
 * crash or closing the window brings them back, and nothing readable is stored. Nothing is sent
 * again on its own: a send that was under way comes back as a draft, and sending it again is
 * the same send to the server. A draft sent in another tab empties here too if it's still the
 * same. Leaving still asks first while a send is on its way, and for any unsent text if this
 * browser refused to save it.
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
    const attempt = (work: () => void) => {
      if (!storage) return
      try {
        work()
      } catch {
        saved = false
      }
    }

    /** Each chat's saved draft that this tab wrote or brought back, by its mark: only those it may remove. */
    const mine = new Map<string, string>()
    // Sends under way and held messages as last saved from here.
    const savedSending = new Map<string, string>()
    let savedHeld = new Map<string, string>()
    let timer: ReturnType<typeof setTimeout> | undefined

    // Sends that were under way, back as drafts: their saved copies go once those are saved.
    const restoredSending: { chatId: string; sendId: string }[] = []
    if (storage) {
      const loaded = loadAll<Reply>(storage, owner)
      for (const [chatId, draft] of loaded.drafts) {
        // One that went already (its tab closed before removing it) isn't brought back.
        if (loaded.sent.get(chatId) === sendIdOf(draft)) continue
        if (adoptDraft(chatId, draft.text, draft.reply, draft.id)) mine.set(chatId, draft.w)
      }
      for (const { chatId, sendId, draft } of loaded.sending) {
        // Gone already, or still saved as the draft too (the page went before that was removed).
        const asDraft = loaded.drafts.get(chatId)
        if (loaded.sent.get(chatId) === sendId || (asDraft && sendIdOf(asDraft) === sendId)) {
          attempt(() => removeSending(storage!, owner.userId, chatId, sendId))
          continue
        }
        // Under way when the page went: back as the same draft, to send again or not.
        holdDraft(chatId, draft)
        restoredSending.push({ chatId, sendId })
      }
      for (const [chatId, list] of loaded.held) {
        for (const copy of list) holdDraft(chatId, copy)
        // As saved, so it's saved again (or removed) below.
        savedHeld.set(chatId, '')
      }
    }

    const revs = new Map<string, number>()
    for (const [chatId, draft] of allDrafts()) revs.set(chatId, draft.rev)
    // Brought back into the composer: saved as this tab's from now on.
    const changed = new Set<string>(
      allDrafts()
        .map(([chatId]) => chatId)
        .filter((id) => !mine.has(id)),
    )

    function saveDrafts() {
      clearTimeout(timer)
      timer = undefined
      if (!storage) return
      saved = true
      for (const chatId of changed) {
        const draft = getDraft<Reply>(chatId)
        attempt(() => {
          if (draft.text.trim() || draft.reply) mine.set(chatId, writeDraft(storage!, owner, chatId, draft))
          else {
            removeDraftIfOurs(storage!, owner.userId, chatId, mine.get(chatId))
            mine.delete(chatId)
          }
          revs.set(chatId, draft.rev)
          changed.delete(chatId)
        })
      }
    }

    // Sends under way and held messages are saved at once: they're what a crash would lose.
    function saveTheRest() {
      const now = new Map(allSending<Reply>())
      for (const [sendId, p] of now)
        if (!savedSending.has(sendId))
          attempt(() => {
            writeSending(storage!, owner, p.chatId, sendId, p)
            savedSending.set(sendId, p.chatId)
          })
      for (const [sendId, chatId] of savedSending)
        if (!now.has(sendId))
          attempt(() => {
            removeSending(storage!, owner.userId, chatId, sendId)
            savedSending.delete(sendId)
          })
      const heldNow = new Map(allHeld<Reply>().map(([chatId, list]) => [chatId, JSON.stringify(list)]))
      for (const [chatId, list] of allHeld<Reply>())
        if (savedHeld.get(chatId) !== heldNow.get(chatId)) attempt(() => writeHeld(storage!, owner, chatId, list))
      for (const chatId of savedHeld.keys())
        if (!heldNow.has(chatId)) attempt(() => writeHeld(storage!, owner, chatId, []))
      savedHeld = heldNow
    }
    // What came back is saved before the copies it came from go, so a crash now loses nothing.
    saveDrafts()
    saveTheRest()
    if (saved)
      for (const { chatId, sendId } of restoredSending)
        attempt(() => removeSending(storage!, owner.userId, chatId, sendId))

    const unsubscribe = subscribeDrafts(() => {
      for (const [chatId, draft] of allDrafts()) if (revs.get(chatId) !== draft.rev) changed.add(chatId)
      for (const chatId of revs.keys()) if (getDraft(chatId).rev !== revs.get(chatId)) changed.add(chatId)
      saveTheRest()
      clearTimeout(timer)
      timer = setTimeout(saveDrafts, SAVE_AFTER_MS)
    })
    // Said apart from whatever the composer holds next, so other tabs hear of it either way.
    const unsubscribeSent = onDraftSent((chatId, sendId) =>
      attempt(() => writeSent(storage!, owner.userId, chatId, sendId)),
    )

    // Another tab sent a draft: if this page holds the very same one, it's gone, not to go twice.
    const onStorage = (e: StorageEvent) => {
      const at = keyOf(owner.userId, e.key)
      if (at?.kind !== 'draftSent') return
      const sent = parseSent(e.newValue)
      if (sent) clearSentDraft<Reply>(at.chatId, (draft) => isSentAs(draft, sent))
    }
    const flush = () => {
      if (timer !== undefined) saveDrafts()
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
      unsubscribeSent()
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('beforeunload', keep)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [session])
}
