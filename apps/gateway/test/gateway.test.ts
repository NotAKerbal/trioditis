import type { AddressInfo } from 'node:net'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, keyId, ready, toBase64Url } from '@trioditis/crypto'
import type { Backend, ClaimedCommand } from '../src/backend.ts'
import { Dispatcher } from '../src/dispatcher.ts'
import { CHUNK } from '../src/events.ts'
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
    recipientKeys: vi.fn(async () => null),
    hosts: vi.fn(async () => []),
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

const batch = (events: unknown[]) => ({
  hostId: 'whatsapp-1',
  network: 'whatsapp',
  commandAddr: 'http://127.0.0.1:8611',
  events,
})
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

  it('applies a big batch in chunks, in order, and acknowledges the last', async () => {
    const backend = fakeBackend()
    const base = await serve(backend)
    const events = Array.from({ length: CHUNK * 2 + 5 }, (_, i) => event(CHUNK * 2 + 5 - i))
    expect(await post(base, batch(events))).toEqual({ status: 200, body: { ackedThrough: CHUNK * 2 + 5 } })
    expect(backend.ingested.map((chunk) => chunk.length)).toEqual([CHUNK, CHUNK, 5])
    expect((backend.ingested[0]![0] as { seq: number }).seq).toBe(1)
  })

  it('answers an empty batch with where Convex is, as a handshake', async () => {
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

  it('reports events the backend refuses as a bridge host bug', async () => {
    const backend = fakeBackend({
      ingest: vi.fn(async () => Promise.reject(new Error('ArgumentValidationError: ...'))),
    })
    expect((await post(await serve(backend), batch([event(1)]))).status).toBe(400)
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
  const command = (id: string): ClaimedCommand =>
    ({
      commandId: id,
      userId: 'u',
      network: 'whatsapp',
      loginId: 'l',
      payload: { type: 'markRead', portalId: 'p', upToEventId: 'e' },
    }) as ClaimedCommand

  function backendWith(commands: ClaimedCommand[]) {
    let handedOut = false
    return fakeBackend({
      hosts: vi.fn(async () => [
        { hostId: 'whatsapp-1', network: 'whatsapp' as const, commandAddr: 'http://host', updatedAt: 1 },
      ]),
      claimCommands: vi.fn(async () => {
        if (handedOut) return []
        handedOut = true
        return commands
      }),
    })
  }

  it('records accepted and rejected commands, and leaves unreachable ones for their lease', async () => {
    const backend = backendWith([command('ok'), command('bad'), command('down'), command('busy')])
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const { commandId } = JSON.parse(init?.body as string)
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
      if (commandId === 'ok') return new Response(null, { status: 202 })
      if (commandId === 'bad') return new Response('unknown portal', { status: 400 })
      if (commandId === 'busy') return new Response(null, { status: 503 })
      throw new TypeError('fetch failed')
    })
    await new Dispatcher(backend, {
      internalToken: TOKEN,
      fetch: fetch as typeof globalThis.fetch,
      log: () => {},
    }).drain()
    expect(backend.commandResult).toHaveBeenCalledTimes(2)
    expect(backend.commandResult).toHaveBeenCalledWith({ commandId: 'ok', accepted: true })
    expect(backend.commandResult).toHaveBeenCalledWith({ commandId: 'bad', accepted: false, error: 'unknown portal' })
  })

  it('sends the payload flattened into the command, with its ID', async () => {
    const backend = backendWith([command('c1')])
    const fetch = vi.fn(async () => new Response(null, { status: 202 }))
    await new Dispatcher(backend, {
      internalToken: TOKEN,
      fetch: fetch as typeof globalThis.fetch,
      log: () => {},
    }).drain()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://host/v1/commands')
    expect(JSON.parse(init.body as string)).toEqual({
      commandId: 'c1',
      userId: 'u',
      loginId: 'l',
      type: 'markRead',
      portalId: 'p',
      upToEventId: 'e',
    })
  })

  it('holds commands for a network with no bridge host', async () => {
    const backend = backendWith([command('c1')])
    backend.hosts = vi.fn(async () => [])
    const fetch = vi.fn()
    await new Dispatcher(backend, {
      internalToken: TOKEN,
      fetch: fetch as typeof globalThis.fetch,
      log: () => {},
    }).drain()
    expect(fetch).not.toHaveBeenCalled()
    expect(backend.commandResult).not.toHaveBeenCalled()
  })
})
