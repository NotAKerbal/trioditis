import { createHash, createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '@trioditis/backend/dataModel'
import { admittedPerson, createSigninServer } from '../src/signin.ts'

const TOKEN = 'internal-token'
const SECRET = 'gateway-secret'

/** An admission as Convex signs it (packages/backend/convex/logins.ts). */
function admit(person = 'a'.repeat(32), expiresAt = Date.now() + 60_000, secret = SECRET) {
  const mac = createHmac('sha256', secret).update(`login-browser-admission\n${person}.${expiresAt}`).digest('base64url')
  return `${person}.${expiresAt}.${mac}`
}
const BROWSER = () => `/login-browser?admission=${admit()}`
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const REDEEMED = {
  loginSessionId: 'login/1' as Id<'loginSessions'>,
  userId: 'user_a',
  hostId: 'meta-1',
  stepId: 'step_1',
}

const servers: Server[] = []
const sockets: Socket[] = []
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) server.close()
})

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return (server.address() as AddressInfo).port
}

/** A bridge host that accepts the browser's upgrade and echoes what it gets. */
async function fakeHost(status = 101) {
  const seen: { url?: string; headers?: IncomingHttpHeaders } = {}
  const server = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  server.on('upgrade', (request, socket) => {
    seen.url = request.url
    seen.headers = request.headers
    if (status !== 101) {
      socket.end(`HTTP/1.1 ${status} Conflict\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64')
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), data])))
  })
  const port = await listen(server)
  return { seen, url: `http://127.0.0.1:${port}` }
}

async function gateway(
  redeem: (args: { ticket: string }) => Promise<typeof REDEEMED | null>,
  hosts: Map<string, string>,
) {
  const server = createSigninServer(
    { redeemSigninTicket: vi.fn(redeem) },
    { internalToken: TOKEN, gatewaySecret: SECRET, bridgeHosts: hosts, log: () => {} },
  )
  return await listen(server)
}

/** A client's text frame, masked as a client's must be. */
function clientFrame(text: string) {
  const payload = Buffer.from(text)
  const mask = Buffer.from([1, 2, 3, 4])
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!))
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, mask, masked])
}

const ticket = (value: string) => clientFrame(JSON.stringify({ type: 'ticket', ticket: value }))

/** Opens a raw upgrade to the gateway, and lets a test wait for what it answers. */
function upgrade(port: number, path: string, extra = '') {
  const socket = connect(port, '127.0.0.1')
  sockets.push(socket)
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
  )
  let received = Buffer.alloc(0)
  socket.on('data', (data: Buffer) => (received = Buffer.concat([received, data])))
  const until = (text: string) =>
    new Promise<string>((resolve, reject) => {
      const check = () => (received.includes(text) ? resolve(received.toString('latin1')) : undefined)
      socket.on('data', check)
      socket.on('close', () =>
        received.includes(text)
          ? resolve(received.toString('latin1'))
          : reject(new Error(`closed: ${received.toString('latin1')}`)),
      )
      check()
    })
  /** The code of the close frame the gateway ends with. */
  const closed = () =>
    new Promise<number>((resolve) => {
      socket.on('close', () => {
        const at = received.indexOf(Buffer.from([0x88, 2]))
        resolve(at < 0 ? 0 : received.readUInt16BE(at + 2))
      })
    })
  return { socket, until, closed }
}

describe('sign-in browser proxy', () => {
  it('joins a redeemed ticket to its bridge host, with only the headers it needs', async () => {
    const host = await fakeHost()
    const redeem = vi.fn(async () => REDEEMED)
    const port = await gateway(redeem, new Map([['meta-1', host.url]]))
    const { socket, until } = upgrade(port, BROWSER(), 'Cookie: session=secret\r\nOrigin: https://evil.test\r\n')
    const head = await until('\r\n\r\n')
    expect(head).toMatch(/^HTTP\/1.1 101 /)
    expect(head).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    // The ticket and what follows it in the same write: the rest goes on to the host.
    socket.write(Buffer.concat([ticket('abc'), Buffer.from('frame')]))
    expect(await until('echo:frame')).toContain('echo:frame')
    expect(redeem).toHaveBeenCalledWith({ ticket: 'abc' })
    expect(host.seen.url).toBe('/v1/logins/login%2F1/browser')
    expect(host.seen.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'x-trioditis-user-id': 'user_a',
      'x-trioditis-step-id': 'step_1',
    })
    // The gateway's own key, not the client's.
    expect(host.seen.headers?.['sec-websocket-key']).not.toBe(KEY)
    expect(host.seen.headers?.cookie).toBeUndefined()
    expect(host.seen.headers?.origin).toBeUndefined()

    socket.write('more')
    expect(await until('echo:more')).toContain('echo:more')
  })

  it('refuses a missing, malformed or unknown ticket', async () => {
    const host = await fakeHost()
    const port = await gateway(async () => null, new Map([['meta-1', host.url]]))
    for (const first of [ticket('nope'), clientFrame('{"type":"viewport"}'), clientFrame('not json')]) {
      const client = upgrade(port, BROWSER())
      await client.until('\r\n\r\n')
      client.socket.write(first)
      expect(await client.closed()).toBe(4401)
    }
    // An unmasked frame isn't a client's.
    const unmasked = upgrade(port, BROWSER())
    await unmasked.until('\r\n\r\n')
    unmasked.socket.write(Buffer.from([0x81, 3, 0x61, 0x62, 0x63]))
    expect(await unmasked.closed()).toBe(4401)
    expect(host.seen.url).toBeUndefined()
  })

  it('closes with 4503 for a host it doesn’t know, or a backend it can’t reach', async () => {
    const unknown = await gateway(async () => REDEEMED, new Map())
    const a = upgrade(unknown, BROWSER())
    await a.until('\r\n\r\n')
    a.socket.write(ticket('abc'))
    expect(await a.closed()).toBe(4503)
    const down = await gateway(async () => {
      throw new Error('fetch failed')
    }, new Map())
    const b = upgrade(down, BROWSER())
    await b.until('\r\n\r\n')
    b.socket.write(ticket('abc'))
    expect(await b.closed()).toBe(4503)
  })

  it('closes with 4409 when the host turns the step away', async () => {
    const host = await fakeHost(409)
    const port = await gateway(async () => REDEEMED, new Map([['meta-1', host.url]]))
    const client = upgrade(port, BROWSER())
    await client.until('\r\n\r\n')
    client.socket.write(ticket('abc'))
    expect(await client.closed()).toBe(4409)
  })

  it('takes no socket without an admission, so nobody can keep a viewer out', async () => {
    const host = await fakeHost()
    const port = await gateway(async () => REDEEMED, new Map([['meta-1', host.url]]))
    // Sockets with no admission, a forged one or an expired one, all from the viewer's own
    // address, are turned away before they take a place.
    for (const path of [
      '/login-browser',
      `/login-browser?admission=${admit('a'.repeat(32), Date.now() + 60_000, 'wrong')}`,
      `/login-browser?admission=${admit('a'.repeat(32), Date.now() - 1)}`,
      '/login-browser?admission=nonsense',
    ]) {
      for (let i = 0; i < 5; i++) {
        const anonymous = upgrade(port, path, 'X-Trioditis-Client-IP: 203.0.113.9\r\n')
        expect(await anonymous.until('\r\n\r\n')).toMatch(/^HTTP\/1.1 401 /)
      }
    }
    const viewer = upgrade(port, BROWSER(), 'X-Trioditis-Client-IP: 203.0.113.9\r\n')
    await viewer.until('\r\n\r\n')
    viewer.socket.write(Buffer.concat([ticket('abc'), Buffer.from('hi')]))
    expect(await viewer.until('echo:hi')).toContain('echo:hi')
  })

  it('lets one person keep only a few sockets waiting for a ticket', async () => {
    const port = await gateway(async () => REDEEMED, new Map())
    const mine = `/login-browser?admission=${admit('b'.repeat(32))}`
    for (let i = 0; i < 2; i++) await upgrade(port, mine).until('\r\n\r\n')
    expect(await upgrade(port, mine).until('\r\n\r\n')).toMatch(/^HTTP\/1.1 503 /)
    // Someone else's still get in.
    expect(await upgrade(port, `/login-browser?admission=${admit('c'.repeat(32))}`).until('\r\n\r\n')).toMatch(
      /^HTTP\/1.1 101 /,
    )
  })

  it('lets one person hold only a couple of viewers, replacing their oldest', async () => {
    const host = await fakeHost()
    const port = await gateway(async () => REDEEMED, new Map([['meta-1', host.url]]))
    const mine = () => `/login-browser?admission=${admit('e'.repeat(32))}`
    const viewers: ReturnType<typeof upgrade>[] = []
    for (let i = 0; i < 3; i++) {
      const v = upgrade(port, mine())
      await v.until('\r\n\r\n')
      v.socket.write(Buffer.concat([ticket(`t${i}`), Buffer.from(`v${i}`)]))
      await v.until(`echo:v${i}`)
      viewers.push(v)
    }
    // The first is closed for the third; the second and third still relay.
    await new Promise((resolve) =>
      viewers[0]!.socket.destroyed ? resolve(null) : viewers[0]!.socket.on('close', resolve),
    )
    viewers[2]!.socket.write('again')
    expect(await viewers[2]!.until('echo:again')).toContain('echo:again')
    expect(viewers[1]!.socket.destroyed).toBe(false)
  })

  it('replaces a person’s oldest viewer even when every place is taken', async () => {
    const host = await fakeHost()
    const server = createSigninServer(
      { redeemSigninTicket: vi.fn(async () => REDEEMED) },
      {
        internalToken: TOKEN,
        gatewaySecret: SECRET,
        bridgeHosts: new Map([['meta-1', host.url]]),
        log: () => {},
        maxConnections: 2,
      },
    )
    const port = await listen(server)
    const open = async (i: number) => {
      const v = upgrade(port, `/login-browser?admission=${admit('f'.repeat(32))}`)
      await v.until('\r\n\r\n')
      v.socket.write(Buffer.concat([ticket(`t${i}`), Buffer.from(`v${i}`)]))
      await v.until(`echo:v${i}`)
      return v
    }
    await open(0)
    await open(1)
    // Both places are this person's; a third takes the oldest's.
    const third = await open(2)
    third.socket.write('still')
    expect(await third.until('echo:still')).toContain('echo:still')
  })

  it('checks admissions', () => {
    expect(admittedPerson(admit('d'.repeat(32)), SECRET)).toBe('d'.repeat(32))
    expect(admittedPerson(admit('d'.repeat(32)) + '.x', SECRET)).toBeNull()
    expect(admittedPerson(admit('D'.repeat(32)), SECRET)).toBeNull()
    expect(admittedPerson(admit('d'.repeat(32), 1000), SECRET, 2000)).toBeNull()
  })

  it('serves nothing else', async () => {
    const port = await gateway(async () => REDEEMED, new Map())
    expect(await upgrade(port, '/v1/events').until('\r\n\r\n')).toMatch(/^HTTP\/1.1 404 /)
    const health = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(health.status).toBe(200)
    expect((await fetch(`http://127.0.0.1:${port}/login-browser`)).status).toBe(400)
  })
})
