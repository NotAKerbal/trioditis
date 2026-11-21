import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, request as httpRequest, STATUS_CODES, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'
import type { Backend } from './backend.ts'
import { describeError } from './log.ts'
import type { createMediaHandler } from './media.ts'

// The gateway's public listener: the sign-in browser's websocket, which Caddy forwards
// /login-browser to (docs/architecture/signin-browser.md, Tickets). The socket's address holds
// an admission Convex signed with the gateway's secret, which the gateway checks before taking
// the socket, so nobody without one takes a place. The first message is the ticket, not part of
// the address, so no proxy's log holds it. The gateway accepts the socket, reads that message,
// redeems the ticket and joins the socket to the bridge host running the login. After that it
// never reads what passes between them: frames of the person's account and what they type.

const MAX_CONNECTIONS = 32
const HANDSHAKE_TIMEOUT_MS = 10_000
/**
 * Sockets still waiting for a ticket have a budget of their own, and one person only a few of
 * them, so nobody can take every place.
 */
const MAX_PENDING = 64
const MAX_PENDING_PER_PERSON = 2
/**
 * One person's viewers, past which their oldest is closed: a person watches one browser at a
 * time (the bridge host replaces the last viewer), and this leaves room for a reload.
 */
const MAX_VIEWERS_PER_PERSON = 2
/** The first message is `{"type":"ticket","ticket":"…"}`: well under this. */
const MAX_TICKET_FRAME = 1024
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Close codes the client shows a reason for (apps/desktop, signin-input.ts). */
export const CLOSE = { badTicket: 4401, refused: 4409, unavailable: 4503 } as const

export interface SigninOptions {
  internalToken: string
  /** GATEWAY_SECRET, which Convex signs admissions with. */
  gatewaySecret: string
  /** Where each bridge host takes requests, by host ID: the ticket names the host, never the client. */
  bridgeHosts: Map<string, string>
  log?: (message: string) => void
  maxConnections?: number
  handshakeTimeoutMs?: number
  /** Serves GET /media/<mediaId> on the same listener (media.ts). */
  media?: ReturnType<typeof createMediaHandler>
}

/** Answers on a socket that hasn't been upgraded, and closes it. */
function refuse(socket: Duplex, status: number) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * Closes an upgraded socket with a websocket close frame (unmasked, as a server's are), then
 * destroys it once the frame is written. A socket paused for the handshake never reads the
 * client's own close, so ending it alone would leave it open, holding its place.
 */
function closeWith(socket: Duplex, code: number) {
  if (socket.destroyed) return
  socket.end(Buffer.from([0x88, 2, code >> 8, code & 0xff]), () => socket.destroy())
}

/**
 * The person an admission (`<person>.<expiresAt>.<mac>`, packages/backend/convex/logins.ts)
 * was signed for, or null for one that isn't Convex's or has expired.
 */
export function admittedPerson(admission: string, secret: string, now = Date.now()): string | null {
  const [person, expiresAt, mac, ...rest] = admission.split('.')
  if (rest.length > 0 || !person || !expiresAt || !mac) return null
  if (!/^[0-9a-f]{32}$/.test(person) || !/^\d{1,15}$/.test(expiresAt) || Number(expiresAt) <= now) return null
  const expected = createHmac('sha256', secret).update(`login-browser-admission\n${person}.${expiresAt}`).digest()
  const given = Buffer.from(mac, 'base64url')
  return given.length === expected.length && timingSafeEqual(given, expected) ? person : null
}

function acceptKey(key: string) {
  return createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64')
}

/**
 * Reads the client's first websocket frame from buf: a masked text frame, small enough to be
 * a ticket. Returns its text and the bytes after it, `null` while it is still arriving, or
 * `false` for anything else.
 */
export function firstFrame(buf: Buffer): { text: string; rest: Buffer } | null | false {
  if (buf.length < 2) return null
  const fin = (buf[0]! & 0x80) !== 0
  const opcode = buf[0]! & 0x0f
  const masked = (buf[1]! & 0x80) !== 0
  let length = buf[1]! & 0x7f
  let offset = 2
  if (!fin || opcode !== 0x1 || !masked || length === 127) return false
  if (length === 126) {
    if (buf.length < 4) return null
    length = buf.readUInt16BE(2)
    offset = 4
  }
  if (length > MAX_TICKET_FRAME) return false
  if (buf.length < offset + 4 + length) return null
  const mask = buf.subarray(offset, offset + 4)
  const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length))
  for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!
  return { text: payload.toString('utf8'), rest: buf.subarray(offset + 4 + length) }
}

function ticketOf(text: string): string {
  try {
    const message = JSON.parse(text) as { type?: unknown; ticket?: unknown }
    return message.type === 'ticket' && typeof message.ticket === 'string' ? message.ticket : ''
  } catch {
    return ''
  }
}

export function createSigninServer(backend: Pick<Backend, 'redeemSigninTicket'>, options: SigninOptions): Server {
  const log = options.log ?? ((message) => console.log(message))
  const maxConnections = options.maxConnections ?? MAX_CONNECTIONS
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS
  let open = 0
  let pending = 0
  const pendingBy = new Map<string, number>()
  // Each viewer with how to give up its place, which closing it does too.
  const viewersBy = new Map<string, { socket: Duplex; leave: () => void }[]>()

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://gateway')
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ ok: true }))
    }
    const media = url.pathname.match(/^\/media\/([^/]+)$/)
    if (media && options.media) return void options.media(request, response, media[1]!)
    // The browser is only ever a websocket.
    response.writeHead(url.pathname === '/login-browser' ? 400 : 404, { 'content-length': '0' })
    response.end()
  })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://gateway')
    if (url.pathname !== '/login-browser') return refuse(socket, 404)
    const key = request.headers['sec-websocket-key']
    if (
      request.method !== 'GET' ||
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      typeof key !== 'string' ||
      request.headers['sec-websocket-version'] !== '13'
    ) {
      return refuse(socket, 400)
    }
    const admitted = admittedPerson(url.searchParams.get('admission') ?? '', options.gatewaySecret)
    if (!admitted) return refuse(socket, 401)
    const person: string = admitted
    if (pending >= MAX_PENDING || (pendingBy.get(person) ?? 0) >= MAX_PENDING_PER_PERSON) {
      return refuse(socket, 503)
    }
    pending++
    pendingBy.set(person, (pendingBy.get(person) ?? 0) + 1)
    let waiting = true
    // A socket stops waiting once its ticket is redeemed (or it fails); only then, as a
    // viewer, does it count against the viewers' limit.
    const doneWaiting = () => {
      if (!waiting) return
      waiting = false
      pending--
      const left = (pendingBy.get(person) ?? 1) - 1
      if (left > 0) pendingBy.set(person, left)
      else pendingBy.delete(person)
    }
    let viewing = false
    const leave = () => {
      if (!viewing) return
      viewing = false
      open--
      const left = (viewersBy.get(person) ?? []).filter((v) => v.socket !== socket)
      if (left.length > 0) viewersBy.set(person, left)
      else viewersBy.delete(person)
    }
    socket.on('close', () => {
      doneWaiting()
      leave()
    })
    socket.on('error', () => socket.destroy())

    // The client's socket is accepted here; the bridge host's is a second one, which the
    // gateway opens with a key of its own. Frames pass between the two as they are: the
    // client's are masked, as a server expects, and the host's aren't, as a client expects.
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )

    let upstream: ReturnType<typeof httpRequest> | null = null
    let joined = false
    let received = head
    const timer = setTimeout(() => fail(CLOSE.unavailable), handshakeTimeoutMs)
    function fail(code: number) {
      doneWaiting()
      leave()
      clearTimeout(timer)
      socket.off('data', onData)
      upstream?.destroy()
      closeWith(socket, code)
    }
    socket.on('close', () => {
      if (!joined) {
        clearTimeout(timer)
        upstream?.destroy()
      }
    })

    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      const frame = firstFrame(received)
      if (frame === null) {
        if (received.length > MAX_TICKET_FRAME + 16) fail(CLOSE.badTicket)
        return
      }
      socket.off('data', onData)
      // Whatever else the client sends waits until the socket is joined to the host.
      socket.pause()
      if (frame === false) return fail(CLOSE.badTicket)
      void join(ticketOf(frame.text), frame.rest)
    }

    async function join(ticket: string, rest: Buffer) {
      if (!ticket) return fail(CLOSE.badTicket)
      let redeemed: Awaited<ReturnType<Backend['redeemSigninTicket']>>
      try {
        redeemed = await backend.redeemSigninTicket({ ticket })
      } catch (error) {
        log(`Sign-in ticket couldn't be redeemed: ${describeError(error)}`)
        return fail(CLOSE.unavailable)
      }
      if (!redeemed) return fail(CLOSE.badTicket)
      // The client left while the ticket was redeemed.
      if (socket.destroyed) return clearTimeout(timer)
      doneWaiting()
      // A person's new viewer takes the place of their oldest, so one person can't fill the
      // viewers' places, however many tickets they redeem.
      // The oldest gives up its place before it's closed, so the new one can take it even when
      // every place is full.
      for (
        let mine = viewersBy.get(person) ?? [];
        mine.length >= MAX_VIEWERS_PER_PERSON;
        mine = viewersBy.get(person) ?? []
      ) {
        const oldest = mine[0]!
        oldest.leave()
        oldest.socket.destroy()
      }
      if (open >= maxConnections) return fail(CLOSE.unavailable)
      open++
      viewing = true
      viewersBy.set(person, [...(viewersBy.get(person) ?? []), { socket, leave }])
      const hostUrl = options.bridgeHosts.get(redeemed.hostId)
      if (!hostUrl) return fail(CLOSE.unavailable)

      const target = new URL(`/v1/logins/${encodeURIComponent(redeemed.loginSessionId)}/browser`, hostUrl)
      // Only what the bridge host needs: nothing of the client's request goes on.
      upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${options.internalToken}`,
          'x-trioditis-user-id': redeemed.userId,
          'x-trioditis-step-id': redeemed.stepId,
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': randomBytes(16).toString('base64'),
          'sec-websocket-version': '13',
        },
      })
      upstream.on('upgrade', (_response, upstreamSocket, upstreamHead) => {
        clearTimeout(timer)
        if (socket.destroyed) return upstreamSocket.destroy()
        joined = true
        if (upstreamHead.length > 0) socket.write(upstreamHead)
        if (rest.length > 0) upstreamSocket.write(rest)
        const close = () => {
          socket.destroy()
          upstreamSocket.destroy()
        }
        upstreamSocket.on('error', close)
        upstreamSocket.on('close', close)
        socket.on('close', close)
        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)
        socket.resume()
      })
      upstream.on('response', (response) => {
        response.resume()
        // A redirect is never followed: the host's address comes from BRIDGE_HOSTS alone. A
        // host that turns the login away (409) says its step is over.
        fail(response.statusCode === 409 ? CLOSE.refused : CLOSE.unavailable)
      })
      upstream.on('error', () => {
        if (!joined) fail(CLOSE.unavailable)
      })
      upstream.end()
    }
    socket.on('data', onData)
    // Bytes that came with the upgrade request may already hold the ticket.
    if (head.length > 0) {
      received = Buffer.alloc(0)
      onData(head)
    }
  })
  return server
}
