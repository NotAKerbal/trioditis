import { useSyncExternalStore } from 'react'

// Drafts live in memory only, per chat: they're plaintext, so they never touch the disk. They're
// kept here, not in a chat pane, so a send or schedule that finishes after the person left the
// chat and came back changes the draft they're looking at, never a copy of it.
//
// Sending and scheduling both take the text out of the draft when they start, so it can't go
// out twice, and what's typed meanwhile is a new draft of its own. Only if one doesn't go does
// its text come back, ahead of whatever is in the composer by then.

export interface Draft<Reply> {
  text: string
  /** The message being replied to, if any. */
  reply: Reply | null
  /** Counts every change, so the composer's view is always the latest. */
  rev: number
}

const store = new Map<string, Draft<unknown>>()
const listeners = new Set<() => void>()
const EMPTY: Draft<never> = { text: '', reply: null, rev: 0 }

/** Whether any chat has a draft or a reply in progress, which a reload would lose. */
export function hasDrafts() {
  for (const draft of store.values()) if (draft.text.trim() || draft.reply) return true
  return false
}

export function getDraft<Reply>(chatId: string): Draft<Reply> {
  return (store.get(chatId) as Draft<Reply> | undefined) ?? EMPTY
}

function change<Reply>(chatId: string, next: Partial<Pick<Draft<Reply>, 'text' | 'reply'>>) {
  const draft = getDraft<Reply>(chatId)
  // Kept even when empty, so the revision only ever goes up.
  store.set(chatId, { ...draft, ...next, rev: draft.rev + 1 })
  for (const listener of listeners) listener()
}

export const setDraftText = (chatId: string, text: string) => change(chatId, { text })
export const setDraftReply = <Reply>(chatId: string, reply: Reply | null) => change(chatId, { reply })

/**
 * Takes the draft to send or schedule, leaving the composer empty. Null when there's nothing to
 * take. Put it back with `restoreDraft` if it doesn't go.
 */
export function takeDraft<Reply>(chatId: string): { text: string; reply: Reply | null } | null {
  const { text, reply } = getDraft<Reply>(chatId)
  if (!text.trim()) return null
  change<Reply>(chatId, { text: '', reply: null })
  return { text: text.trim(), reply }
}

/** Puts back a send or schedule that didn't go: its text ahead of anything typed since, its reply if none is set. */
export function restoreDraft<Reply>(chatId: string, text: string, reply: Reply | null) {
  const now = getDraft<Reply>(chatId)
  change(chatId, { text: now.text ? `${text}\n${now.text}` : text, reply: now.reply ?? reply })
}

/** Adds a cancelled scheduled message's text below the draft. Says whether there was one already. */
export function appendToDraft(chatId: string, text: string): boolean {
  const now = getDraft(chatId).text
  change(chatId, { text: now.trim() ? `${now}\n${text}` : text })
  return !!now.trim()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A chat's draft, kept up to date with every change, from wherever it came. */
export function useDraft<Reply>(chatId: string): Draft<Reply> {
  return useSyncExternalStore(subscribe, () => getDraft<Reply>(chatId))
}
