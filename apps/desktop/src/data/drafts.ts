import { useSyncExternalStore } from 'react'

// Drafts live in memory only, per chat: they're plaintext, so they never touch the disk. They're
// kept here, not in a chat pane, so a send or schedule that finishes after the person left the
// chat and came back changes the draft they're looking at, never a copy of it.

export interface Draft<Reply> {
  text: string
  /** The message being replied to, if any. */
  reply: Reply | null
  /** Counts every change, so an action that finishes later can tell if the person typed since. */
  rev: number
  /** The revision being scheduled now, if any: until that answers, it's not sent or scheduled again. */
  scheduling: number | null
}

const store = new Map<string, Draft<unknown>>()
const listeners = new Set<() => void>()
const EMPTY: Draft<never> = { text: '', reply: null, rev: 0, scheduling: null }

export function getDraft<Reply>(chatId: string): Draft<Reply> {
  return (store.get(chatId) as Draft<Reply> | undefined) ?? EMPTY
}

function change<Reply>(chatId: string, next: Partial<Pick<Draft<Reply>, 'text' | 'reply'>>) {
  const draft = getDraft<Reply>(chatId)
  // Kept even when empty, so the revision only ever goes up.
  store.set(chatId, { ...draft, ...next, rev: draft.rev + 1 })
  notify()
}

function notify() {
  for (const listener of listeners) listener()
}

/**
 * Claims the draft for scheduling, returning its revision, or null if a schedule for it is
 * already on its way. While claimed it isn't sent or scheduled again, so the same message can't
 * go out now and at its time too. Release it with `releaseDraft` when the schedule answers.
 */
export function claimDraft(chatId: string): number | null {
  const draft = getDraft(chatId)
  if (draft.scheduling !== null) return null
  store.set(chatId, { ...draft, scheduling: draft.rev })
  notify()
  return draft.rev
}

export function releaseDraft(chatId: string, rev: number) {
  const draft = getDraft(chatId)
  if (draft.scheduling !== rev) return
  store.set(chatId, { ...draft, scheduling: null })
  notify()
}

export const setDraftText = (chatId: string, text: string) => change(chatId, { text })
export const setDraftReply = <Reply>(chatId: string, reply: Reply | null) => change(chatId, { reply })

/** Takes the draft for sending, leaving the composer empty. Null when there's nothing to send, or it's being scheduled. */
export function takeDraft<Reply>(chatId: string): { text: string; reply: Reply | null } | null {
  const { text, reply, scheduling } = getDraft<Reply>(chatId)
  if (!text.trim() || scheduling !== null) return null
  change<Reply>(chatId, { text: '', reply: null })
  return { text: text.trim(), reply }
}

/** Puts back a send that didn't go: its text ahead of anything typed since, its reply if none is set. */
export function restoreDraft<Reply>(chatId: string, text: string, reply: Reply | null) {
  const now = getDraft<Reply>(chatId)
  change(chatId, { text: now.text ? `${text}\n${now.text}` : text, reply: now.reply ?? reply })
}

/** Clears what was scheduled, unless the draft changed since revision `rev`: then it stays. */
export function clearDraftIf(chatId: string, rev: number) {
  if (getDraft(chatId).rev === rev) change(chatId, { text: '', reply: null })
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
