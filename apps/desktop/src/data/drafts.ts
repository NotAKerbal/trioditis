import { useSyncExternalStore } from 'react'

// Drafts live in memory, per chat, and are kept across a reload only sealed to the person's own
// key (saved-drafts.ts): plaintext never touches the disk. They're kept here, not in a chat
// pane, so a send or schedule that finishes after the person left the chat and came back
// changes the draft they're looking at, never a copy of it.
//
// Sending and scheduling both take the text out of the draft when they start, so it can't go
// out twice, and what's typed meanwhile is a new draft of its own. Until it settles it's kept
// as a send under way (`takeForSend`), saved like a draft, so a crash before the server has it
// loses nothing. Only if one doesn't go does its text come back, ahead of whatever is in the
// composer by then.
//
// Each draft has an identity from when it gets its text until that text is sent or emptied. A
// send's client message ID is worked out from it and the text (saved-drafts.ts), so the same
// draft sent from two tabs, or again after a reload, is one send to the server.

export interface Draft<Reply> {
  text: string
  /** The message being replied to, if any. */
  reply: Reply | null
  /** Counts every change, so the composer's view is always the latest. */
  rev: number
  /** This draft's identity while it has something in it; '' when empty. */
  id: string
  /**
   * The cancelled scheduled messages whose text was restored into it. The server keeps each
   * one's copy until this draft is sent or scheduled (scheduled.forget), so losing the draft
   * here loses nothing: it can be restored again.
   */
  origins: string[]
}

/** A draft's content, as it's taken, kept and put back. */
export interface DraftCopy<Reply> {
  text: string
  reply: Reply | null
  /** Its identity, when it should come back as the same draft. */
  id?: string
  origins?: string[]
}

/** A send or schedule under way, by its client message ID. */
export interface PendingSend<Reply> extends DraftCopy<Reply> {
  chatId: string
  id: string
}

const store = new Map<string, Draft<unknown>>()
const sending = new Map<string, PendingSend<unknown>>()
const listeners = new Set<() => void>()
const sentListeners = new Set<(chatId: string, clientMessageId: string) => void>()
const EMPTY: Draft<never> = { text: '', reply: null, rev: 0, id: '', origins: [] }

const filled = (d: { text: string; reply: unknown }) => !!d.text.trim() || d.reply !== null
const newDraftId = () => crypto.randomUUID().replaceAll('-', '')
const notify = () => {
  for (const listener of listeners) listener()
}

/** Sends and schedules under way, whose text is out of the draft until they settle. */
let inFlight = 0

/**
 * Runs the send or schedule of a taken draft, putting it back included. Until it settles, the
 * text is in neither the draft nor the server, so `hasDrafts` counts it.
 */
export async function whileSending<T>(work: () => Promise<T>): Promise<T> {
  inFlight++
  try {
    return await work()
  } finally {
    inFlight--
  }
}

/** Whether a reload would lose text: a draft, a reply in progress, or a send not yet settled. */
export function hasDrafts() {
  if (inFlight > 0 || sending.size > 0) return true
  for (const draft of store.values()) if (filled(draft)) return true
  return false
}

/** Whether a send or schedule is on its way, its text out of the draft and not yet stored. */
export const sendsInFlight = () => inFlight > 0

/** Every chat's draft that has something in it. */
export function allDrafts<Reply>(): [string, Draft<Reply>][] {
  return ([...store] as [string, Draft<Reply>][]).filter(([, d]) => filled(d))
}

/** Every send or schedule under way, by client message ID. */
export const allSending = <Reply>() => [...sending] as [string, PendingSend<Reply>][]

export function getDraft<Reply>(chatId: string): Draft<Reply> {
  return (store.get(chatId) as Draft<Reply> | undefined) ?? EMPTY
}

/**
 * Changes a draft. One that gets something in it after being empty is a new draft, with a new
 * identity unless `id` names the one it's coming back as. So is one whose text was cleared,
 * even with its reply kept: typing the same words to the same message again is a new message.
 */
function change<Reply>(
  chatId: string,
  next: Partial<Pick<Draft<Reply>, 'text' | 'reply'>>,
  id?: string,
  origins: string[] = [],
) {
  const draft = getDraft<Reply>(chatId)
  const merged = { ...draft, ...next }
  const has = filled(merged)
  const cleared = !!draft.text.trim() && !merged.text.trim()
  const identity = !has ? '' : filled(draft) && draft.id && !cleared ? draft.id : (id ?? newDraftId())
  // Restored text erased is no longer this draft's: its cancelled copy stays to restore again.
  const kept = !has || cleared ? [] : [...new Set([...draft.origins, ...origins])]
  // Kept even when empty, so the revision only ever goes up.
  store.set(chatId, { ...merged, rev: draft.rev + 1, id: identity, origins: kept })
  notify()
}

export const setDraftText = (chatId: string, text: string) => change(chatId, { text })
export const setDraftReply = <Reply>(chatId: string, reply: Reply | null) => change(chatId, { reply })

/**
 * Takes the draft to send or schedule, leaving the composer empty. Null when there's nothing to
 * take. Put it back with `restoreDraft` if it doesn't go.
 */
export function takeDraft<Reply>(chatId: string): { text: string; reply: Reply | null; id: string } | null {
  const { text, reply, id } = getDraft<Reply>(chatId)
  if (!text.trim()) return null
  change<Reply>(chatId, { text: '', reply: null })
  return { text: text.trim(), reply, id }
}

/**
 * Takes the draft to send or schedule, as `takeDraft` does, and notes it as on its way, by the
 * client message ID `sendIdOf` works out, until `endSend`. Both in one change: there's never a
 * moment the composer is empty and the send under way not yet noted, so its saved copy is
 * written before the draft's is cleared (I2 in saved-drafts.ts).
 */
export function takeForSend<Reply>(
  chatId: string,
  sendIdOf: (taken: { text: string; reply: Reply | null; id: string }) => string,
): { text: string; reply: Reply | null; id: string; origins: string[]; clientMessageId: string } | null {
  const { text, reply, id, origins } = getDraft<Reply>(chatId)
  if (!text.trim()) return null
  const taken = { text: text.trim(), reply, id, origins }
  const clientMessageId = sendIdOf(taken)
  sending.set(clientMessageId, { ...taken, chatId })
  change<Reply>(chatId, { text: '', reply: null })
  return { ...taken, clientMessageId }
}

/**
 * Settles a send or schedule. One that went (or had gone already) is announced, so other tabs
 * holding the same draft can empty theirs; one that didn't is the caller's to put back.
 */
export function endSend(clientMessageId: string, went: boolean) {
  const pending = sending.get(clientMessageId)
  if (!pending) return
  sending.delete(clientMessageId)
  notify()
  if (went) for (const listener of sentListeners) listener(pending.chatId, clientMessageId)
}

/** Calls `listener` when a draft has gone, as its chat and client message ID. */
export function onDraftSent(listener: (chatId: string, clientMessageId: string) => void) {
  sentListeners.add(listener)
  return () => sentListeners.delete(listener)
}

/**
 * Puts back a send or schedule that didn't go: its text ahead of anything typed since, its reply
 * if none is set. Into an empty composer it comes back as the same draft (`id`), so sending it
 * again is the same send.
 */
export function restoreDraft<Reply>(
  chatId: string,
  text: string,
  reply: Reply | null,
  id?: string,
  origins: string[] = [],
) {
  const now = getDraft<Reply>(chatId)
  change(chatId, { text: now.text ? `${text}\n${now.text}` : text, reply: now.reply ?? reply }, id, origins)
}

/** Brings back a draft saved before a reload, as the same draft, into a chat with none. */
export function adoptDraft<Reply>(
  chatId: string,
  text: string,
  reply: Reply | null,
  id: string,
  origins: string[] = [],
) {
  if (filled(getDraft(chatId))) return false
  change<Reply>(chatId, { text, reply }, id, origins)
  return true
}

/** Empties a draft another tab has sent, unless `stillSame` says it has changed since. */
export function clearSentDraft<Reply>(chatId: string, stillSame: (draft: Draft<Reply>) => boolean) {
  const now = getDraft<Reply>(chatId)
  if (!filled(now) || !stillSame(now)) return false
  change<Reply>(chatId, { text: '', reply: null })
  return true
}

/**
 * Adds a cancelled scheduled message's text below the draft, and its reply if the draft has
 * none: a reply already set is the newer choice. Says whether there was a draft already.
 */
export function appendToDraft<Reply>(
  chatId: string,
  text: string,
  reply: Reply | null = null,
  origin?: string,
): boolean {
  const now = getDraft<Reply>(chatId)
  change<Reply>(
    chatId,
    { text: now.text.trim() ? `${now.text}\n${text}` : text, reply: now.reply ?? reply },
    undefined,
    origin ? [origin] : [],
  )
  return !!now.text.trim()
}

/** Calls `listener` after every change to any draft or send under way. */
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const subscribe = subscribeDrafts

/** A chat's draft, kept up to date with every change, from wherever it came. */
export function useDraft<Reply>(chatId: string): Draft<Reply> {
  return useSyncExternalStore(subscribe, () => getDraft<Reply>(chatId))
}
