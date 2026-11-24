// @vitest-environment happy-dom
import { generateKeyPair, ready, toBase64Url } from '@trioditis/crypto'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// A send under way when the page goes comes back after the reload through keep-unsent's own
// saving and loading (sealed, in this browser's storage), and sending it again goes under the
// same client message ID: keep-unsent's rule and the outbox's are one.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me = vi.hoisted(() => ({ session: { userId: 'user-1', keyPair: undefined as unknown } }))
vi.mock('~/lib/convex.ts', () => ({ convex: { mutation: vi.fn() } }))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => me.session }))

type ChatId = import('../src/data/chats.ts').ChatId
type SendArgs = Parameters<import('../src/data/outbox.ts').OutboxPort['send']>[0]

/** One page load: fresh stores and modules, and keep-unsent running as the app runs it. */
async function openPage() {
  vi.resetModules()
  const { useKeepUnsent } = await import('../src/features/shell/keep-unsent.ts')
  const drafts = await import('../src/data/drafts.ts')
  const { outbox } = await import('../src/data/outbox.ts')
  const host = document.createElement('div')
  const root: Root = createRoot(host)
  function Keeper() {
    useKeepUnsent()
    return null
  }
  await act(async () => root.render(createElement(Keeper)))
  return { drafts, outbox, close: () => act(async () => root.unmount()) }
}

/** A port whose sends never answer (the page goes first), noting each client message ID. */
function port(ids: string[]) {
  return {
    send: vi.fn((args: SendArgs) => {
      ids.push(args.clientMessageId)
      return new Promise<never>(() => {})
    }),
    schedule: vi.fn(),
    sendAgain: vi.fn(),
    upload: vi.fn(),
  } as unknown as import('../src/data/outbox.ts').OutboxPort
}

let bridgeKey = ''
beforeAll(async () => {
  await ready()
  me.session.keyPair = generateKeyPair()
  bridgeKey = toBase64Url(generateKeyPair().publicKey)
})

describe('a send under way across a reload', () => {
  it('comes back as the same draft and goes under the same client message ID', async () => {
    const chat = 'chat-reload' as ChatId
    const as = () => ({
      userId: me.session.userId,
      keyPair: me.session.keyPair as never,
      bridgeKey,
      bridgeStatus: 'ready' as const,
    })
    const ids: string[] = []

    const before = await openPage()
    before.drafts.setDraftText(chat, 'sent as the page went')
    before.drafts.setDraftReply(chat, { chatId: chat, eventId: '$asked' })
    void before.outbox(port(ids), as()).sendDraft(chat)
    await vi.waitFor(() => expect(ids).toHaveLength(1))
    // keep-unsent has saved it, sealed, as a send under way: nothing readable is stored.
    await vi.waitFor(() =>
      expect(Object.keys(localStorage).some((k) => k.startsWith('trioditis.draftSending.user-1.'))).toBe(true),
    )
    expect(JSON.stringify(localStorage)).not.toContain('sent as the page went')
    await before.close()

    const after = await openPage()
    expect(after.drafts.getDraft(chat)).toMatchObject({
      text: 'sent as the page went',
      reply: { eventId: '$asked' },
    })
    void after.outbox(port(ids), as()).sendDraft(chat)
    await vi.waitFor(() => expect(ids).toHaveLength(2))
    expect(ids[1]).toBe(ids[0])
    await after.close()
  })
})
