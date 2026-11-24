import type { api } from '@trioditis/backend/api'
import type { Attachment } from '@trioditis/core'
import type { Envelope, KeyPair } from '@trioditis/crypto'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import type { BridgeStatus } from '~/data/bridge-ready.ts'
import type { ChatId } from '~/data/chats.ts'
import type { Message } from '~/data/messages.ts'
import {
  appendToDraft,
  endSend,
  getDraft,
  restoreDraft,
  setDraftReply,
  takeForSend,
  whileSending,
} from '~/data/drafts.ts'
import { messageTypeOf } from '~/data/media.ts'
import { draftSendId } from '~/data/saved-drafts.ts'
import { checkWithinAYear, formatWhen } from '~/data/snooze.ts'
import { usedOutcome, type AlreadyUsed } from '~/features/chat/already-used.ts'
import { restoreConflict } from '~/features/chat/cancel-scheduled.ts'
import { filesOf, removeFile, setSending, type OutgoingFile } from '~/features/chat/outgoing-files.ts'
import { sendAgain as makeAttempt, type RetryState } from '~/features/chat/send-again.ts'
import { errorMessage } from '~/lib/errors.ts'
import { newClientId, sealMessage, sealText, tryOpen, type MessagePlaintext } from '~/lib/sealed.ts'

// The client's outbox: everything between the person pressing Send (or Schedule, or Send again)
// and the server holding the sealed message. The chat pane only shows what comes back.
//
// A draft is taken out of the composer as it goes, so it can't go twice, and is noted as a send
// under way (drafts.ts) until the server answers. Its client message ID comes from the draft's
// identity, reply and text (`sendIdOf`), the same rule keep-unsent uses when a reload brings a
// send back: so sending it again, from another tab or after a reload, is the same send to the
// server. A send whose ID was used already is never sent again by itself (already-used.ts).
//
// The server's mutations and the upload come in through a port, so tests can stand in for them;
// the drafts and the files waiting in the composer are this page's own stores.

/** The server calls the outbox makes: Convex's mutations and the media upload, in the app. */
export interface OutboxPort {
  send: (args: FunctionArgs<typeof api.messages.send>) => Promise<FunctionReturnType<typeof api.messages.send>>
  schedule: (
    args: FunctionArgs<typeof api.scheduled.create>,
  ) => Promise<FunctionReturnType<typeof api.scheduled.create>>
  sendAgain: (
    args: FunctionArgs<typeof api.messages.sendAgain>,
  ) => Promise<FunctionReturnType<typeof api.messages.sendAgain>>
  /** Encrypts a file and gives it to the bridge host that runs the chat (media.ts uploadFile). */
  upload: (chatId: ChatId, file: File) => Promise<Attachment>
}

/** Who sends, and the bridge key their messages are sealed to. */
export interface SendingAs {
  userId: string
  keyPair: KeyPair
  /** The bridge host's public key; until it's known nothing can be sealed for it. */
  bridgeKey: string | undefined
  bridgeStatus: BridgeStatus
}

/**
 * What became of a send or schedule, and what to tell the person, if anything:
 * - `empty`: there was nothing to send, or its files are on their way already.
 * - `blocked`: nothing was taken: there's no bridge key, or the time can't be used.
 * - `sent` / `scheduled`: the server has it.
 * - `used`: its send ID was used already; settled as `usedOutcome` says, never sent again.
 * - `failed`: what hadn't gone is back in the composer.
 */
export type Outcome =
  | { kind: 'empty'; say?: undefined }
  | { kind: 'blocked'; say: string }
  | { kind: 'sent'; say?: undefined }
  | { kind: 'scheduled'; say: string }
  | { kind: 'used'; action: 'done' | 'check' | 'again'; say: string }
  | { kind: 'failed'; say: string }

/** What became of a send again: `declined` when the server didn't make the attempt. */
export type AgainOutcome =
  | { kind: 'empty'; say?: undefined }
  | { kind: 'blocked'; say: string }
  | { kind: 'sent'; say?: undefined }
  | { kind: 'declined'; say: string }
  | { kind: 'failed'; say: string }

/** A cancelled message put back in the composer, or why it wasn't. */
export type RestoreOutcome = { kind: 'restored'; added: boolean } | { kind: 'conflict'; say: string }

type Reply = Message

/**
 * Why nothing can be sent without a bridge key, said the same wherever a send starts. The key
 * can load after the composer does on a cold start, so a click meanwhile is told to wait.
 */
export function noBridgeKey(status: BridgeStatus): string {
  if (status === 'loading') return 'Still connecting to the server. Try again in a moment.'
  if (status === 'error')
    return 'The server’s bridge key couldn’t be loaded, so nothing can be sent. Reload to try again.'
  return 'This server has no bridge key yet, so nothing can be sent.'
}

/**
 * The client message ID a draft is sent under. The one rule for it: keep-unsent uses it too, to
 * tell a send brought back by a reload from one that went, so the two can never disagree and
 * send a draft twice.
 */
export const sendIdOf = (draft: { id: string; text: string; reply: { eventId: string } | null }) =>
  draftSendId(draft.id, draft.text, draft.reply?.eventId)

/** A reply's event ID, when it's to a message in the chat it goes to: a network can't reply across chats. */
const replyIn = (reply: Reply | null, chatId: ChatId) =>
  reply && (reply.chatId === chatId || !reply.chatId) ? reply.eventId : undefined

/** A draft taken to send: its content, identity and the send ID it goes under. */
type Taken = { text: string; reply: Reply | null; id: string; clientMessageId: string }

/** The outbox for one person, sending through `port`. Cheap to make: it holds no state of its own. */
export function outbox(port: OutboxPort, as: SendingAs) {
  const seal = (message: MessagePlaintext, clientMessageId: string, bridgeKey: string) =>
    sealMessage(message, clientMessageId, as.userId, as.keyPair.publicKey, bridgeKey)
  const blocked = () => ({ kind: 'blocked', say: noBridgeKey(as.bridgeStatus) }) as const

  /** Puts a taken draft back as the same draft, so sending it again is the same send. */
  function putBack(chatId: ChatId, taken: Taken) {
    // Back first, then the copy under way goes (I2 in saved-drafts.ts).
    restoreDraft(chatId, taken.text, taken.reply, taken.id)
    endSend(taken.clientMessageId, false)
  }

  /**
   * Settles a send or schedule the server took as new (`used` null), or found its ID used
   * already (already-used.ts): done, and not sent again; may have gone, so the person checks
   * the chat first; or never went, so its text comes back as a new draft.
   */
  function settle(chatId: ChatId, taken: Taken, used: AlreadyUsed | null): Outcome | null {
    if (!used) {
      endSend(taken.clientMessageId, true)
      return null
    }
    const { action, say } = usedOutcome(used)
    if (action === 'again') {
      // No identity given: a new draft, so sending it again is a new message.
      restoreDraft(chatId, taken.text, taken.reply)
      endSend(taken.clientMessageId, false)
    } else endSend(taken.clientMessageId, true)
    return { kind: 'used', action, say }
  }

  /** Sends the chat's draft: its files, each with a message of its own, or else its text. */
  async function sendDraft(chatId: ChatId): Promise<Outcome> {
    const files = filesOf(chatId)
    if (!getDraft(chatId).text.trim() && !files.length) return { kind: 'empty' }
    // Nothing leaves the composer until it can be sent.
    const bridgeKey = as.bridgeKey
    if (!bridgeKey) return blocked()
    if (files.length) return sendFiles(chatId, files, bridgeKey)
    // Noted as under way, and saved so, before the composer is cleared (I2).
    const taken = takeForSend<Reply>(chatId, sendIdOf)
    if (!taken) return { kind: 'empty' }
    return whileSending(async () => {
      let answer: FunctionReturnType<typeof api.messages.send>
      try {
        const replyTo = replyIn(taken.reply, chatId)
        const sealed = seal({ type: 'text', body: taken.text }, taken.clientMessageId, bridgeKey)
        answer = await port.send({
          chatId,
          clientMessageId: taken.clientMessageId,
          ...sealed,
          ...(replyTo ? { replyTo } : {}),
        })
      } catch (e) {
        // Refused (a mutation that fails never ran), or never sent: nothing of it went.
        putBack(chatId, taken)
        return { kind: 'failed', say: errorMessage(e, 'That message couldn’t be sent.') }
      }
      return settle(chatId, taken, answer === 'queued' ? null : answer) ?? { kind: 'sent' }
    })
  }

  /**
   * Sends the composer's files, each as a message of its own (a network takes one file a
   * message), in order, the text as the first one's caption and the reply on it. Each file is
   * encrypted and given to the bridge host that will send it before its message is sealed with
   * its key. A file leaves the composer once its message is queued; at the first that can't be,
   * the rest stay, and the text comes back if it hadn't gone.
   */
  async function sendFiles(chatId: ChatId, outgoing: readonly OutgoingFile[], bridgeKey: string): Promise<Outcome> {
    if (outgoing.some((f) => f.sending)) return { kind: 'empty' }
    const ids = outgoing.map((f) => f.id)
    setSending(chatId, ids, true)
    // The text, when there is any, is taken as a send of its own would be, under the same send
    // ID: sent again from another tab, or after a reload brought it back without its file
    // (files are only ever in memory), it's the same send to the server, so it never goes twice.
    // A reply alone is taken too, so it goes with the first file and nothing else.
    const taken = takeForSend<Reply>(chatId, sendIdOf)
    const reply = taken ? taken.reply : getDraft<Reply>(chatId).reply
    if (!taken && reply) setDraftReply(chatId, null)
    const keepLeft = () =>
      setSending(
        chatId,
        ids.filter((id) => filesOf(chatId).some((left) => left.id === id)),
        false,
      )
    return whileSending(async (): Promise<Outcome> => {
      let first = true
      for (const f of outgoing) {
        const caption = first ? taken?.text : undefined
        const clientMessageId = first && taken ? taken.clientMessageId : newClientId()
        const replyTo = first ? replyIn(reply, chatId) : undefined
        let answer: FunctionReturnType<typeof api.messages.send>
        try {
          const attachment = await port.upload(chatId, f.file)
          // With no caption the body is the file's name, as bridgev2 expects; it isn't shown twice.
          const message: MessagePlaintext = {
            type: messageTypeOf(attachment.mime),
            body: caption || attachment.name || 'File',
            attachments: [attachment],
          }
          const sealed = seal(message, clientMessageId, bridgeKey)
          answer = await port.send({ chatId, clientMessageId, ...sealed, ...(replyTo ? { replyTo } : {}) })
        } catch (e) {
          // Refused (a mutation that fails never ran), or never sent: nothing of it went.
          if (first && taken) putBack(chatId, taken)
          else if (first && reply && !getDraft<Reply>(chatId).reply) setDraftReply(chatId, reply)
          keepLeft()
          return { kind: 'failed', say: errorMessage(e, `${f.file.name || 'A file'} couldn’t be sent.`) }
        }
        const used = answer === 'queued' ? null : answer
        // The text's send ID was used already: by the text alone, from another tab, or by this
        // file with it before a reload. Which isn't known, so nothing more goes by itself: the
        // text is settled as any send of it would be, and the files stay for the person to send
        // or remove once they've looked at the chat.
        if (used) {
          keepLeft()
          if (first && taken) return settle(chatId, taken, used)!
          const { action, say } = usedOutcome(used)
          return { kind: 'used', action, say }
        }
        if (first && taken) settle(chatId, taken, null)
        removeFile(chatId, f.id)
        first = false
      }
      return { kind: 'sent' }
    })
  }

  /**
   * Schedules the chat's draft text for `sendAt`. Taken out of the composer as it goes, like a
   * send: it can't be sent or scheduled twice, and it comes back, ahead of anything typed since,
   * only if it doesn't go.
   */
  async function schedule(chatId: ChatId, sendAt: number): Promise<Outcome> {
    if (!getDraft(chatId).text.trim()) return { kind: 'empty' }
    const bridgeKey = as.bridgeKey
    if (!bridgeKey) return blocked()
    try {
      checkWithinAYear(sendAt)
    } catch (e) {
      return { kind: 'blocked', say: errorMessage(e, 'That time can’t be used.') }
    }
    const taken = takeForSend<Reply>(chatId, sendIdOf)
    if (!taken) return { kind: 'empty' }
    return whileSending(async (): Promise<Outcome> => {
      try {
        const sealed = seal({ type: 'text', body: taken.text }, taken.clientMessageId, bridgeKey)
        const replyTo = replyIn(taken.reply, chatId)
        const answer = await port.schedule({
          chatId,
          clientMessageId: taken.clientMessageId,
          sendAt,
          ...sealed,
          ...(replyTo ? { replyTo } : {}),
        })
        const used = typeof answer === 'object' ? answer : null
        return settle(chatId, taken, used) ?? { kind: 'scheduled', say: `Scheduled for ${formatWhen(sendAt)}` }
      } catch (e) {
        putBack(chatId, taken)
        return { kind: 'failed', say: errorMessage(e, 'That message couldn’t be scheduled.') }
      }
    })
  }

  /**
   * Makes the next attempt of a send that failed or may not have gone, as the server's retry
   * state allows (send-again.ts): one attempt per link of the chain, whatever the clicks. The
   * person chose to risk a duplicate on the network, once each time.
   */
  async function sendAgain(
    message: Pick<Message, 'body' | 'clientMessageId' | 'replyTo'>,
    state: RetryState | undefined,
  ): Promise<AgainOutcome> {
    const text = message.body?.body
    const original = message.clientMessageId
    if (!text || !state || !original) return { kind: 'empty' }
    const bridgeKey = as.bridgeKey
    if (!bridgeKey) return blocked()
    // A file goes again as it was: the bridge host still has it, and its key is in the copy.
    const files = message.body!.attachments?.filter((a) => !a.failed && a.mediaId)
    try {
      const created = await makeAttempt(state, (nextId) => {
        const sealed = files?.length
          ? seal({ type: message.body!.type, body: text, attachments: files }, nextId, bridgeKey)
          : sealText(text, nextId, as.userId, as.keyPair.publicKey, bridgeKey)
        return port.sendAgain({
          clientMessageId: original,
          nextId,
          ...sealed,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        })
      })
      return created
        ? { kind: 'sent' }
        : { kind: 'declined', say: 'That message was sent again already, or can’t be now.' }
    } catch (e) {
      return { kind: 'failed', say: errorMessage(e, 'That message couldn’t be sent again.') }
    }
  }

  /**
   * Copies a cancelled message's text, and the message it replies to, into the chat's draft as
   * an ordinary new draft: into an empty one, or one replying to the same message. The server
   * keeps its row until the person discards it; nothing goes by itself.
   */
  function restoreCancelled(chatId: ChatId, body: string, replyTo: string | null, reply: Reply | null): RestoreOutcome {
    if (restoreConflict(getDraft<Reply>(chatId), replyTo))
      return { kind: 'conflict', say: 'Clear or send your draft first.' }
    return { kind: 'restored', added: appendToDraft(chatId, body, reply) }
  }

  /** The text of a cancelled message's copy, as the server returned it; undefined if it won't open. */
  function cancelledText(copy: Envelope | null | undefined, clientMessageId: string): string | undefined {
    const body = tryOpen<MessagePlaintext>(copy, as.keyPair, 'message', as.userId, clientMessageId)?.body
    return typeof body === 'string' ? body : undefined
  }

  return { sendDraft, schedule, sendAgain, restoreCancelled, cancelledText }
}

export type Outbox = ReturnType<typeof outbox>
