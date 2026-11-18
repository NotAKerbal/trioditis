import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, keyId, ready, toBase64Url } from '@trioditis/crypto'
import type { Backend, ClaimedCommand } from '../src/backend.ts'
import { parseBridgeHosts } from '../src/config.ts'
import { Dispatcher } from '../src/dispatcher.ts'
import { CHUNK } from '../src/events.ts'
import { describeError } from '../src/log.ts'
import { ConvexError } from 'convex/values'
import { createGatewayServer } from '../src/server.ts'

const TOKEN = 'internal-token'

beforeAll(ready)

function fakeBackend(overrides: Partial<Backend> = {}): Backend & { ingested: unknown[][] } {
  const ingested: unknown[][] = []
  return {
    ingested,
    ingest: vi.fn(async (args) => {
      ingested.push(args.events)
      const last = (args.events as { seq: number }[]).at(-1)
      return { ackedThrough: last?.seq ?? 0 }
    }),
    quarantineInvalid: vi.fn(async (args) => ({ ackedThrough: args.seq })),
    recipientKeys: vi.fn(async () => null),
    claimCommands: vi.fn(async () => []),
    commandResult: vi.fn(async () => null),
    watchPendingCommands: () => () => {},
    close: async () => {},
    ...overrides,
  }
}

const servers: { close: () => void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function serve(backend: Backend, agentAccessPublicKey = toBase64Url(generateKeyPair().publicKey)) {
  const server = createGatewayServer(backend, { internalToken: TOKEN, agentAccessPublicKey, log: () => {} })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const batch = (events: unknown[]) => ({ hostId: 'whatsapp-1', network: 'whatsapp', events })
const event = (seq: number) => ({
  seq,
  type: 'typing',
  userId: 'u',
  loginId: 'l',
  at: 1,
  portalId: 'p',
  sender: { self: true },
  typing: true,
  timeoutMs: 1,
})

async function post(base: string, body: unknown, token = TOKEN) {
  const response = await fetch(`${base}/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe('events', () => {
  it('needs the internal token', async () => {
    const base = await serve(fakeBackend())
    expect((await post(base, batch([]), 'wrong')).status).toBe(401)
  })

  it('refuses something that isn’t a batch', async () => {
    const base = await serve(fakeBackend())
    expect((await post(base, { events: [] })).status).toBe(400)
  })

  it('refuses a batch whose sequence numbers are unusable', async () => {
    const base = await serve(fakeBackend())
    expect((await post(base, batch([{ ...event(1), seq: 0 }]))).status).toBe(400)
    expect((await post(base, batch([{ ...event(1), seq: 1.5 }]))).status).toBe(400)
    expect((await post(base, batch([{ type: 'typing' }]))).status).toBe(400)
  })

  it('quarantines an event the Convex client can’t encode, without sending it', async () => {
    const backend = fakeBackend()
    const result = await post(await serve(backend), batch([event(1), { ...event(2), $weird: 'x' }, event(3)]))
    expect(result).toEqual({ status: 200, body: { ackedThrough: 3 } })
    expect(backend.quarantineInvalid).toHaveBeenCalledWith({
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      seq: 2,
      type: 'typing',
    })
    expect(backend.ingested.flat().map((e) => (e as { seq: number }).seq)).toEqual([1, 3])
  })

  it('quarantines an event whose type isn’t a string', async () => {
    const backend = fakeBackend()
    backend.ingest = vi.fn(async (args) => {
      const events = args.events as { seq: number; type?: unknown }[]
      if (events.some((e) => typeof e.type !== 'string')) throw new Error('ArgumentValidationError')
      return { ackedThrough: events.at(-1)?.seq ?? 0 }
    })
    const result = await post(await serve(backend), batch([{ ...event(1), type: { toString: 1 } }]))
    expect(result).toEqual({ status: 200, body: { ackedThrough: 1 } })
    expect(backend.quarantineInvalid).toHaveBeenCalledWith({
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      seq: 1,
      type: 'unknown',
    })
  })

  it('quarantines an event with a sequence number but no type', async () => {
    const backend = fakeBackend()
    backend.ingest = vi.fn(async (args) => {
      const events = args.events as { seq: number; type?: string }[]
      if (events.some((e) => !e.type)) throw new Error('ArgumentValidationError: Value does not match validator.')
      return { ackedThrough: events.at(-1)?.seq ?? 0 }
    })
    const result = await post(await serve(backend), batch([event(1), { seq: 2 }]))
    expect(result).toEqual({ status: 200, body: { ackedThrough: 2 } })
    expect(backend.quarantineInvalid).toHaveBeenCalledWith({
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      seq: 2,
      type: 'unknown',
    })
  })

  it('applies a big batch in chunks, in order, and acknowledges the last', async () => {
    const backend = fakeBackend()
    const base = await serve(backend)
    const events = Array.from({ length: CHUNK * 2 + 5 }, (_, i) => event(CHUNK * 2 + 5 - i))
    expect(await post(base, batch(events))).toEqual({ status: 200, body: { ackedThrough: CHUNK * 2 + 5 } })
    expect(backend.ingested.map((chunk) => chunk.length)).toEqual([CHUNK, CHUNK, 5])
    expect((backend.ingested[0]![0] as { seq: number }).seq).toBe(1)
  })

  it('splits a batch by size as well as count, and quarantines an event too big to be valid', async () => {
    const backend = fakeBackend()
    const base = await serve(backend)
    const padding = 'x'.repeat(900 * 1024)
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ({ ...event(i + 1), portalId: padding })),
      { ...event(7), portalId: 'y'.repeat(2 * 1024 * 1024) },
    ]
    expect(await post(base, batch(events))).toEqual({ status: 200, body: { ackedThrough: 7 } })
    // The second chunk holds the oversized event, so its valid events go one at a time.
    expect(backend.ingested.map((part) => part.length)).toEqual([4, 1, 1])
    expect(backend.quarantineInvalid).toHaveBeenCalledWith({
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      seq: 7,
      type: 'typing',
    })
  })

  it('sends the rest of a chunk when the backend stops partway', async () => {
    const backend = fakeBackend()
    backend.ingest = vi.fn(async (args) => {
      const events = args.events as { seq: number }[]
      backend.ingested.push(events)
      // Applies at most two per call, as a backend near its transaction budget would.
      return { ackedThrough: events[Math.min(1, events.length - 1)]!.seq }
    })
    const result = await post(await serve(backend), batch([event(1), event(2), event(3), event(4), event(5)]))
    expect(result).toEqual({ status: 200, body: { ackedThrough: 5 } })
    expect(backend.ingested.map((part) => part.map((e) => (e as { seq: number }).seq))).toEqual([
      [1, 2, 3, 4, 5],
      [3, 4, 5],
      [5],
    ])
  })

  it('answers an empty batch with where Convex is, as a heartbeat', async () => {
    const backend = fakeBackend({ ingest: vi.fn(async () => ({ ackedThrough: 41 })) })
    expect(await post(await serve(backend), batch([]))).toEqual({ status: 200, body: { ackedThrough: 41 } })
  })

  it('passes a gap back as 409 with the sequence to resend from', async () => {
    const backend = fakeBackend({ ingest: vi.fn(async () => ({ expectedSeq: 7 })) })
    expect(await post(await serve(backend), batch([event(9)]))).toEqual({ status: 409, body: { expectedSeq: 7 } })
  })

  it('acknowledges nothing when the backend is down', async () => {
    const backend = fakeBackend({ ingest: vi.fn(async () => Promise.reject(new Error('fetch failed'))) })
    expect((await post(await serve(backend), batch([event(1)]))).status).toBe(503)
  })

  it('quarantines the one event the backend refuses and applies the rest', async () => {
    const backend = fakeBackend()
    backend.ingest = vi.fn(async (args) => {
      const events = args.events as { seq: number; bad?: boolean }[]
      if (events.some((e) => e.bad)) throw new Error('ArgumentValidationError: Value does not match validator.')
      return { ackedThrough: events.at(-1)?.seq ?? 0 }
    })
    const result = await post(await serve(backend), batch([event(1), { ...event(2), bad: true }, event(3)]))
    expect(result).toEqual({ status: 200, body: { ackedThrough: 3 } })
    expect(backend.quarantineInvalid).toHaveBeenCalledWith({
      hostId: 'whatsapp-1',
      network: 'whatsapp',
      seq: 2,
      type: 'typing',
    })
  })
})

describe('keys', () => {
  it('answers 409 for someone without an identity key', async () => {
    const response = await fetch(`${await serve(fakeBackend())}/v1/keys/u1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(409)
  })

  it('returns the identity and agent-access keys with their key IDs', async () => {
    const identity = toBase64Url(generateKeyPair().publicKey)
    const agent = toBase64Url(generateKeyPair().publicKey)
    const backend = fakeBackend({
      recipientKeys: vi.fn(async () => ({ identityPublicKey: identity, agentGrantedPortals: [] })),
    })
    const response = await fetch(`${await serve(backend, agent)}/v1/keys/u1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    const body = (await response.json()) as { identity: unknown; agentAccess: { kid: string } }
    expect(body.identity).toEqual({ publicKey: identity, kid: keyId(Buffer.from(identity, 'base64url')) })
    expect(body.agentAccess.kid).toBe(keyId(Buffer.from(agent, 'base64url')))
  })
})

describe('dispatcher', () => {
  const hosts = new Map([['whatsapp-1', 'http://host']])
  const command = (id: string, hostId = 'whatsapp-1'): ClaimedCommand =>
    ({
      commandId: id,
      lease: 3,
      hostId,
      userId: 'u',
      network: 'whatsapp',
      loginId: 'l',
      payload: { type: 'markRead', portalId: 'p', upToEventId: 'e' },
    }) as ClaimedCommand

  function backendWith(commands: ClaimedCommand[]) {
    let handedOut = false
    return fakeBackend({
      claimCommands: vi.fn(async () => {
        if (handedOut) return []
        handedOut = true
        return commands
      }),
    })
  }

  const dispatcher = (backend: Backend, fetch: unknown) =>
    new Dispatcher(backend, {
      internalToken: TOKEN,
      bridgeHosts: hosts,
      fetch: fetch as typeof globalThis.fetch,
      log: () => {},
    })

  it('records accepted and rejected commands with their lease, and leaves unreachable ones for their lease', async () => {
    const backend = backendWith([
      command('ok'),
      command('bad'),
      command('text'),
      command('newer'),
      command('down'),
      command('busy'),
    ])
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { commandId } = JSON.parse(init?.body as string) as { commandId: string }
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      expect(init?.redirect).toBe('error')
      if (commandId === 'ok') return new Response(null, { status: 202 })
      if (commandId === 'bad') return Response.json({ error: 'unsupported' }, { status: 400 })
      // A host answering with free text (which could quote what the person typed) is recorded
      // only as an invalid command.
      if (commandId === 'text') return new Response('your code 123456 was wrong', { status: 400 })
      // A code this gateway doesn't know (from a newer host) can't be stored either.
      if (commandId === 'newer') return Response.json({ error: 'some_new_code' }, { status: 400 })
      if (commandId === 'busy') return new Response(null, { status: 503 })
      throw new TypeError('fetch failed')
    })
    await dispatcher(backend, fetch).drain()
    expect(backend.commandResult).toHaveBeenCalledTimes(4)
    expect(backend.commandResult).toHaveBeenCalledWith({
      commandId: 'newer',
      lease: 3,
      accepted: false,
      error: 'invalid_command',
    })
    expect(backend.claimCommands).toHaveBeenCalledWith({ limit: 20, hostIds: ['whatsapp-1'] })
    expect(backend.commandResult).toHaveBeenCalledWith({ commandId: 'ok', lease: 3, accepted: true })
    expect(backend.commandResult).toHaveBeenCalledWith({
      commandId: 'bad',
      lease: 3,
      accepted: false,
      error: 'unsupported',
    })
    expect(backend.commandResult).toHaveBeenCalledWith({
      commandId: 'text',
      lease: 3,
      accepted: false,
      error: 'invalid_command',
    })
  })

  it('sends the payload, sealed part and deadline flattened into the command, to the configured address', async () => {
    const sealedPart = { v: 1 as const, nonce: 'n', ct: 'c', keys: [] }
    const backend = backendWith([{ ...command('c1'), sealed: sealedPart, notAfter: 99 }])
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    await dispatcher(backend, fetch).drain()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host/v1/commands')
    expect(JSON.parse(init.body as string)).toEqual({
      commandId: 'c1',
      userId: 'u',
      loginId: 'l',
      type: 'markRead',
      portalId: 'p',
      upToEventId: 'e',
      sealed: sealedPart,
      notAfter: 99,
    })
  })

  it('holds a command for a host it has no address for', async () => {
    const backend = backendWith([command('c1', 'unknown-host')])
    const fetch = vi.fn()
    await dispatcher(backend, fetch).drain()
    expect(fetch).not.toHaveBeenCalled()
    expect(backend.commandResult).not.toHaveBeenCalled()
  })
})

describe('config and logs', () => {
  it('reads bridge host addresses and refuses anything else', () => {
    expect(parseBridgeHosts('whatsapp-1=http://127.0.0.1:8611, fake-1=http://bridge:8612')).toEqual(
      new Map([
        ['whatsapp-1', 'http://127.0.0.1:8611'],
        ['fake-1', 'http://bridge:8612'],
      ]),
    )
    expect(() => parseBridgeHosts('whatsapp-1=http://127.0.0.1:8611/path')).toThrow()
    expect(() => parseBridgeHosts('whatsapp-1')).toThrow()
  })

  it('logs errors without anything they quote', () => {
    const error = new Error(
      'ArgumentValidationError: Value does not match validator.\nPath: .events[0]\nValue: {"body":"secret"}',
    )
    expect(describeError(error)).toBe('Error: ArgumentValidationError')
    expect(describeError(new TypeError('fetch failed'))).toBe('TypeError: fetch failed')
    expect(describeError(new Error('Field name my secret starts with a $'))).toBe('Error')
    expect(describeError(new ConvexError('Not the gateway'))).toBe('ConvexError: Not the gateway')
  })
})
