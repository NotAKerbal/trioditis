import { useEffect } from 'react'
import { hasOutgoingFiles } from '~/features/chat/outgoing-files.ts'
import {
  adoptDraft,
  allDrafts,
  allSending,
  clearSentDraft,
  getDraft,
  hasDrafts,
  onDraftSent,
  sendsInFlight,
  subscribeDrafts,
  type Draft,
} from '~/data/drafts.ts'
import { sendIdOf } from '~/data/outbox.ts'
import { keyOf, loadAll, newKnown, parseSent, syncChat, withChatLock, type ChatKnown } from '~/data/saved-drafts.ts'
import { useSession } from '~/lib/session.tsx'

/** How long after the last keystroke a draft is sealed and saved. */
const SAVE_AFTER_MS = 400

type Reply = { eventId: string }

/** Whether `draft` is the one sent as `clientMessageId`: same identity, reply and text. */
const isSentAs = (draft: Draft<Reply>, clientMessageId: string) => !!draft.id && sendIdOf(draft) === clientMessageId

/**
 * Keeps unsent text across a reload. Drafts and sends under way are sealed to the person's own
 * key and saved in this browser, per chat, under the rules in saved-drafts.ts (I1: one tab at a
 * time per chat; I2: write before delete). A reload, a crash or closing the window brings them
 * back, and nothing readable is stored. Nothing is sent again on its own: a send that was under
 * way comes back as a draft, and sending it again is the same send to the server. A draft sent
 * in another tab empties here too if it's still the same. Leaving asks first while a send is on
 * its way, and while anything couldn't be saved.
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

    const knowns = new Map<string, ChatKnown>()
    const known = (chatId: string) => {
      let k = knowns.get(chatId)
      if (!k) knowns.set(chatId, (k = newKnown()))
      return k
    }
    // Chats with something not yet saved: a change waiting, or a save that failed.
    const unsaved = new Set<string>()
    const revs = new Map<string, number>()
    const sentToNote = new Map<string, string[]>()

    if (storage) {
      const loaded = loadAll<Reply>(storage, owner)
      for (const [chatId, draft] of loaded.drafts) {
        known(chatId).w = draft.w
        // One that went already (its tab closed before removing it) isn't brought back.
        if (loaded.sent.get(chatId) === sendIdOf(draft)) continue
        adoptDraft(chatId, draft.text, draft.reply, draft.id)
      }
      for (const { chatId, sendId, copy } of loaded.sending) {
        // Gone already, or still saved as the draft too (the page went before that was removed).
        const asDraft = loaded.drafts.get(chatId)
        const gone = loaded.sent.get(chatId) === sendId || (asDraft && sendIdOf(asDraft) === sendId)
        // Under way when the page went: back as the same draft, to send again or not. Into a
        // composer with something in it already, it waits, saved, for the next load.
        if (gone || adoptDraft(chatId, copy.text, copy.reply, copy.id)) known(chatId).sending.add(sendId)
      }
      for (const chatId of knowns.keys()) unsaved.add(chatId)
      for (const [chatId, draft] of allDrafts()) if (known(chatId).w) revs.set(chatId, draft.rev)
    }

    // One save at a time per chat in this tab; a change meanwhile saves again after.
    const running = new Map<string, Promise<boolean>>()
    const again = new Set<string>()
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    function wantFor(chatId: string) {
      const draft = getDraft<Reply>(chatId)
      const filled = !!draft.text.trim() || !!draft.reply
      return {
        draft: filled ? { text: draft.text, reply: draft.reply, id: draft.id } : null,
        draftChanged: revs.get(chatId) !== draft.rev,
        sending: new Map(allSending<Reply>().filter(([, p]) => p.chatId === chatId)),
        sent: sentToNote.get(chatId) ?? [],
        rev: draft.rev,
      }
    }

    function saveNow(chatId: string) {
      if (!storage) return false
      const want = wantFor(chatId)
      const ok = syncChat(storage, owner, chatId, want, known(chatId))
      if (ok) {
        revs.set(chatId, want.rev)
        // Only the notes this save wrote: one added meanwhile waits for the next.
        const left = (sentToNote.get(chatId) ?? []).filter((s) => !want.sent.includes(s))
        if (left.length) sentToNote.set(chatId, left)
        else sentToNote.delete(chatId)
        if (!timers.has(chatId)) unsaved.delete(chatId)
      } else unsaved.add(chatId)
      return ok
    }

    /** Saves the chat now, in its lock; resolves whether what it held then is stored. */
    function save(chatId: string): Promise<boolean> {
      clearTimeout(timers.get(chatId))
      timers.delete(chatId)
      if (!storage) return Promise.resolve(false)
      const busy = running.get(chatId)
      if (busy) {
        again.add(chatId)
        // What it holds now is in the save that runs after this one.
        return busy.then(() => running.get(chatId) ?? save(chatId))
      }
      const run = withChatLock(owner.userId, chatId, () => saveNow(chatId)).finally(() => {
        running.delete(chatId)
        if (again.delete(chatId)) void save(chatId)
      })
      running.set(chatId, run)
      return run
    }

    // Typing waits a moment; a send or a sent note is saved at once.
    const shapes = new Map<string, string>()
    function changed() {
      const chats = new Set([
        ...allDrafts().map(([c]) => c),
        ...revs.keys(),
        ...allSending().map(([, p]) => p.chatId),
        ...knowns.keys(),
      ])
      for (const chatId of chats) {
        const want = wantFor(chatId)
        const shape = JSON.stringify([[...want.sending.keys()], want.sent])
        if (shape !== (shapes.get(chatId) ?? '[[],[]]')) {
          shapes.set(chatId, shape)
          unsaved.add(chatId)
          void save(chatId)
        } else if (want.draftChanged && !timers.has(chatId)) {
          unsaved.add(chatId)
          timers.set(
            chatId,
            setTimeout(() => void save(chatId), SAVE_AFTER_MS),
          )
        }
      }
    }

    if (storage) {
      // What came back is saved before the copies it came from go (I2).
      for (const chatId of unsaved) void save(chatId)
    }
    const unsubscribe = subscribeDrafts(changed)
    // Said apart from whatever the composer holds next, so other tabs hear of it either way.
    const unsubscribeSent = onDraftSent((chatId, sendId) => {
      sentToNote.set(chatId, [...(sentToNote.get(chatId) ?? []), sendId])
      unsaved.add(chatId)
      void save(chatId)
    })

    // Another tab sent a draft: if this page holds the very same one, it's gone, not to go twice.
    const onStorage = (e: StorageEvent) => {
      const at = keyOf(owner.userId, e.key)
      if (at?.kind !== 'draftSent') return
      const sent = parseSent(e.newValue)
      if (sent) clearSentDraft<Reply>(at.chatId, (draft) => isSentAs(draft, sent))
    }
    // The page is going: no time to wait for a lock, so what's waiting is saved straight away,
    // still writing before deleting.
    const flush = () => {
      for (const chatId of timers.keys()) {
        clearTimeout(timers.get(chatId))
        timers.delete(chatId)
        saveNow(chatId)
      }
    }
    const keep = (event: BeforeUnloadEvent) => {
      flush()
      if (sendsInFlight() || hasOutgoingFiles() || ((!storage || unsaved.size > 0) && hasDrafts()))
        event.preventDefault()
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
