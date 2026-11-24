import { describe, expect, it } from 'vitest'
import {
  canDeleteMessage,
  canEditMessage,
  DELETE_CONFIRM_MS,
  EDIT_SHOWN_MS,
  settle,
  withChanges,
  type PendingDelete,
  type PendingEdit,
} from '../src/data/edits.ts'
import type { Message } from '../src/data/messages.ts'

const MINUTE = 60_000
const NOW = 1_000_000_000

function message(id: string, fields: Partial<Message> = {}): Message {
  return {
    id: id as Message['id'],
    chatId: 'c1' as Message['chatId'],
    eventId: `net_${id}`,
    pending: false,
    self: true,
    ghostId: undefined,
    at: NOW - MINUTE,
    body: { type: 'text', body: 'hello' },
    edited: false,
    edits: 0,
    deleted: false,
    replyTo: undefined,
    clientMessageId: undefined,
    delivery: undefined,
    ...fields,
  }
}

const edit = (messageId: string, text: string, clientMessageId = `e_${messageId}`): PendingEdit => ({
  messageId: messageId as PendingEdit['messageId'],
  clientMessageId,
  text,
})
const del = (messageId: string, at = NOW): PendingDelete => ({ messageId: messageId as PendingDelete['messageId'], at })
const byId = (...list: Message[]) => new Map(list.map((m) => [m.id as string, m]))

describe('which messages can be edited or deleted', () => {
  it('offers only the person’s own text that reached the network, within the network’s limit', () => {
    expect(canEditMessage(message('a'), 'whatsapp', NOW)).toBe(true)
    expect(canEditMessage(message('a', { self: false, ghostId: 'g' }), 'whatsapp', NOW)).toBe(false)
    expect(canEditMessage(message('a', { pending: true }), 'whatsapp', NOW)).toBe(false)
    expect(canEditMessage(message('a', { deleted: true, body: null }), 'whatsapp', NOW)).toBe(false)
    expect(canEditMessage(message('a', { deleting: true }), 'whatsapp', NOW)).toBe(false)
    // WhatsApp edits for 15 minutes, Telegram 48 hours, Slack any time; Google Messages and Bluesky can’t.
    expect(canEditMessage(message('a', { at: NOW - 16 * MINUTE }), 'whatsapp', NOW)).toBe(false)
    expect(canEditMessage(message('a', { at: 0 }), 'slack', NOW)).toBe(true)
    expect(canEditMessage(message('a', { at: NOW - 47 * 60 * MINUTE }), 'telegram', NOW)).toBe(true)
    expect(canEditMessage(message('a', { at: NOW - 49 * 60 * MINUTE }), 'telegram', NOW)).toBe(false)
    expect(canEditMessage(message('a'), 'gmessages', NOW)).toBe(false)
    // GroupMe's connector keeps an edit's text unsealed, and X can edit only some chats.
    expect(canEditMessage(message('a'), 'groupme', NOW)).toBe(false)
    expect(canEditMessage(message('a'), 'twitter', NOW)).toBe(false)
    // Signal allows ten edits of a message.
    expect(canEditMessage(message('a', { edits: 9 }), 'signal', NOW)).toBe(true)
    expect(canEditMessage(message('a', { edits: 10 }), 'signal', NOW)).toBe(false)
    expect(canEditMessage(message('a'), 'bluesky', NOW)).toBe(false)
  })

  it('doesn’t edit a file, a cut-short message, or one that can’t be opened', () => {
    const file = { mediaId: 'm', mime: 'image/png', size: 1, name: 'a.png', key: 'k', nonce: 'n' }
    expect(
      canEditMessage(message('a', { body: { type: 'text', body: 'cap', attachments: [file] } }), 'signal', NOW),
    ).toBe(false)
    expect(canEditMessage(message('a', { body: { type: 'image', body: 'a.png' } }), 'signal', NOW)).toBe(false)
    expect(canEditMessage(message('a', { body: { type: 'text', body: 'long', truncated: true } }), 'signal', NOW)).toBe(
      false,
    )
    expect(canEditMessage(message('a', { body: null }), 'signal', NOW)).toBe(false)
    // Formatting, a forwarded Telegram message's header among it, would be lost; Telegram won't edit a forward.
    const forwarded = { type: 'text' as const, body: 'Forwarded message from Ann', html: '<blockquote>hi</blockquote>' }
    expect(canEditMessage(message('a', { body: forwarded }), 'telegram', NOW)).toBe(false)
  })

  it('deletes files too, within each network’s own limit', () => {
    const file = message('a', { body: { type: 'image', body: 'a.png' } })
    expect(canDeleteMessage(file, 'whatsapp', NOW)).toBe(true)
    expect(canDeleteMessage(message('a', { at: NOW - 47 * 60 * MINUTE }), 'whatsapp', NOW)).toBe(true)
    expect(canDeleteMessage(message('a', { at: NOW - 49 * 60 * MINUTE }), 'whatsapp', NOW)).toBe(false)
    expect(canDeleteMessage(message('a', { at: 0 }), 'gmessages', NOW)).toBe(true)
    expect(canDeleteMessage(message('a'), 'gvoice', NOW)).toBe(false)
    // mautrix-meta doesn't check Messenger's or Instagram's answer to an edit or a deletion.
    for (const network of ['meta', 'instagram'] as const) {
      expect(canEditMessage(message('a'), network, NOW)).toBe(false)
      expect(canDeleteMessage(message('a'), network, NOW)).toBe(false)
    }
    expect(canDeleteMessage(message('a', { self: false, ghostId: 'g' }), 'whatsapp', NOW)).toBe(false)
  })
})

describe('the person’s edits and deletions before the network has them', () => {
  it('shows an edit’s text and a deletion at once', () => {
    const shown = withChanges([message('a'), message('b'), message('c')], [edit('a', 'changed')], [del('b')])
    expect(shown[0]).toMatchObject({ body: { type: 'text', body: 'changed' }, edited: true, editing: true })
    expect(shown[1]).toMatchObject({ deleting: true })
    expect(shown[2]).toEqual(message('c'))
  })

  it('keeps an edit until the server shows its text, or for a moment once the network has it', () => {
    const waiting = settle([edit('a', 'changed')], [], byId(message('a')), new Map(), NOW)
    expect(waiting).toMatchObject({ edits: [edit('a', 'changed')], ended: [], next: null })
    const shownByServer = byId(message('a', { edited: true, body: { type: 'text', body: 'changed' } }))
    expect(settle([edit('a', 'changed')], [], shownByServer, new Map(), NOW).edits).toEqual([])
    // Sent, but the text isn't there yet: kept a moment, the same object once marked.
    const sent = new Map([['e_a', 'sent' as const]])
    const first = settle([edit('a', 'changed')], [], byId(message('a')), sent, NOW)
    expect(first.edits).toEqual([{ ...edit('a', 'changed'), sentAt: NOW }])
    expect(first.next).toBe(NOW + EDIT_SHOWN_MS)
    const again = settle(first.edits, [], byId(message('a')), sent, NOW + 1)
    expect(again.edits[0]).toBe(first.edits[0])
    expect(settle(first.edits, [], byId(message('a')), sent, NOW + EDIT_SHOWN_MS).edits).toEqual([])
  })

  it('tells of an edit that failed or may not have been made, and never keeps it to send again', () => {
    for (const how of ['failed', 'unknown'] as const) {
      const out = settle([edit('a', 'changed')], [], byId(message('a')), new Map([['e_a', how]]), NOW)
      expect(out.edits).toEqual([])
      expect(out.ended).toEqual([{ kind: 'edit', how }])
    }
  })

  it('drops an edit of a message that was deleted or left the list, without saying anything', () => {
    const out = settle([edit('a', 'x'), edit('b', 'y')], [], byId(message('a', { deleted: true })), new Map(), NOW)
    expect(out).toMatchObject({ edits: [], ended: [] })
  })

  it('keeps a deletion until the server shows it, and tells of one not confirmed in time', () => {
    const kept = settle([], [del('a')], byId(message('a')), new Map(), NOW + 1000)
    expect(kept).toMatchObject({ deletes: [del('a')], ended: [], next: NOW + DELETE_CONFIRM_MS })
    expect(settle([], [del('a')], byId(message('a', { deleted: true })), new Map(), NOW).deletes).toEqual([])
    const late = settle([], [del('a')], byId(message('a')), new Map(), NOW + DELETE_CONFIRM_MS)
    expect(late).toMatchObject({ deletes: [], ended: [{ kind: 'delete', how: 'unconfirmed' }] })
  })
})
