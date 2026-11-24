import { createHmac, timingSafeEqual } from 'node:crypto'
import { request as httpRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { describeError } from './log.ts'

// GET /media/<mediaId> on the gateway's public listener: a person's encrypted file, fetched from
// the bridge host that has it (docs/architecture/client-api.md, Media). The client decrypts it
// with the key in its sealed message; the gateway only ever passes ciphertext along. The
// request carries a media token Convex signed (packages/backend/convex/media.ts), which says
// who is asking and which bridge hosts to ask, and the bridge host gives a file only to its
// owner.
//
// PUT /media/<mediaId> goes the other way: a file the client encrypted to send, passed to the
// one bridge host that will send it, named by an upload token Convex signed for that chat. The
// key goes only in the sealed send that follows.

/** A media ID as the bridge host makes them: 128 random bits, base64url. */
const MEDIA_ID = /^[A-Za-z0-9_-]{16,64}$/
const MAX_HOSTS = 8
/** Files being passed along at once, and for one person: a chat's pictures load a few at a time. */
const MAX_IN_FLIGHT = 64
const MAX_IN_FLIGHT_PER_PERSON = 16
/** How long a bridge host has to start answering. */
const HOST_TIMEOUT_MS = 15_000
/** The largest file a client may send: 100 MiB and its 16-byte tag (the bridge host's MaxClientFile). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024 + 16
/** Files being sent on at once, and for one person: a few at a time is plenty for a composer. */
const MAX_UPLOADS = 16
const MAX_UPLOADS_PER_PERSON = 4

export interface MediaOptions {
  internalToken: string
  /** GATEWAY_SECRET, which Convex signs media tokens with. */
  gatewaySecret: string
  /** Where each bridge host takes requests, by host ID: the token names hosts, never their addresses. */
  bridgeHosts: Map<string, string>
  log?: (message: string) => void
  maxInFlight?: number
  maxInFlightPerPerson?: number
  maxUploadBytes?: number
}

export interface MediaClaims {
  userId: string
  hostIds: string[]
}

/**
 * Who a media token (`<payload>.<mac>`) was signed for and the hosts it names, or null for one
 * that isn't Convex's or has expired. An upload token is signed for another purpose, so neither
 * kind is taken as the other.
 */
export function mediaClaims(
  token: string,
  secret: string,
  now = Date.now(),
  purpose: 'media-access' | 'media-upload' = 'media-access',
): MediaClaims | null {
  const [payload, mac, ...rest] = token.split('.')
  if (rest.length > 0 || !payload || !mac || payload.length > 2048) return null
  const expected = createHmac('sha256', secret).update(`${purpose}\n${payload}`).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  let claims: { u?: unknown; h?: unknown; e?: unknown }
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const { u, h, e } = claims
  if (typeof u !== 'string' || !u || typeof e !== 'number' || e <= now) return null
  if (!Array.isArray(h) || h.length > MAX_HOSTS || !h.every((id) => typeof id === 'string')) return null
  return { userId: u, hostIds: h as string[] }
}

function bearer(request: IncomingMessage) {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

/** Asks one bridge host for the file; resolves with its response, whatever the status. */
function ask(hostUrl: string, mediaId: string, userId: string, internalToken: string) {
  const target = new URL(`/v1/media/${mediaId}`, hostUrl)
  let upstream: ClientRequest | undefined
  const answered = new Promise<IncomingMessage>((resolve, reject) => {
    // Only what the bridge host needs: nothing of the client's request goes on. A redirect is
    // never followed: the host's address comes from BRIDGE_HOSTS alone.
    upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'GET',
      headers: { authorization: `Bearer ${internalToken}`, 'x-trioditis-user-id': userId },
      timeout: HOST_TIMEOUT_MS,
    })
    upstream.on('response', resolve)
    upstream.on('timeout', () => upstream!.destroy(new Error('timed out')))
    upstream.on('error', reject)
    upstream.end()
  })
  return { answered, abort: () => upstream?.destroy() }
}

/** Gives one bridge host a file to keep; resolves with its status. */
function put(
  hostUrl: string,
  mediaId: string,
  userId: string,
  internalToken: string,
  body: IncomingMessage,
  length: number,
) {
  const target = new URL(`/v1/media/${mediaId}`, hostUrl)
  let upstream: ClientRequest | undefined
  const answered = new Promise<number>((resolve, reject) => {
    upstream = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${internalToken}`,
        'x-trioditis-user-id': userId,
        'content-type': 'application/octet-stream',
        'content-length': String(length),
      },
      timeout: HOST_TIMEOUT_MS,
    })
    upstream.on('response', (answer) => {
      answer.resume()
      resolve(answer.statusCode ?? 502)
    })
    upstream.on('timeout', () => upstream!.destroy(new Error('timed out')))
    upstream.on('error', reject)
    body.on('error', (error) => upstream!.destroy(error))
    body.pipe(upstream)
  })
  return { answered, abort: () => upstream?.destroy() }
}

export function createMediaHandler(options: MediaOptions) {
  const log = options.log ?? ((message) => console.log(message))
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT
  const maxPerPerson = options.maxInFlightPerPerson ?? MAX_IN_FLIGHT_PER_PERSON
  const maxUploadBytes = options.maxUploadBytes ?? MAX_UPLOAD_BYTES
  let inFlight = 0
  const inFlightBy = new Map<string, number>()
  let uploads = 0
  const uploadsBy = new Map<string, number>()

  const answer = (response: ServerResponse, status: number, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store', ...headers })
    response.end()
  }

  async function upload(request: IncomingMessage, response: ServerResponse, mediaId: string) {
    // What isn't read is left: the connection closes after the answer.
    const refuse = (status: number, headers: Record<string, string> = {}) =>
      answer(response, status, { connection: 'close', ...headers })
    if (!MEDIA_ID.test(mediaId)) return refuse(404)
    const claims = mediaClaims(bearer(request), options.gatewaySecret, Date.now(), 'media-upload')
    // An upload token names the one host that runs the chat's account.
    const hostUrl = claims?.hostIds.length === 1 ? options.bridgeHosts.get(claims.hostIds[0]!) : undefined
    if (!claims) return refuse(401)
    if (!hostUrl) return refuse(503, { 'retry-after': '5' })
    // Its whole length is said first, so one too large is turned away before any of it comes.
    const length = Number(request.headers['content-length'])
    if (!request.headers['content-length'] || !Number.isSafeInteger(length) || length < 0) return refuse(411)
    if (length > maxUploadBytes) return refuse(413)
    const person = claims.userId
    if (uploads >= MAX_UPLOADS || (uploadsBy.get(person) ?? 0) >= MAX_UPLOADS_PER_PERSON) {
      return refuse(503, { 'retry-after': '1' })
    }
    uploads++
    uploadsBy.set(person, (uploadsBy.get(person) ?? 0) + 1)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      uploads--
      const left = (uploadsBy.get(person) ?? 1) - 1
      if (left > 0) uploadsBy.set(person, left)
      else uploadsBy.delete(person)
    }
    response.on('close', finish)
    const sent = put(hostUrl, mediaId, person, options.internalToken, request, length)
    response.on('close', () => !response.writableFinished && sent.abort())
    let status: number
    try {
      status = await sent.answered
    } catch (error) {
      if (response.destroyed) return finish()
      log(`Bridge host ${claims.hostIds[0]} unreachable for an upload: ${describeError(error)}`)
      return refuse(502)
    }
    // The host's own answer for what the client can act on: kept, an ID in use, too large or
    // malformed. Anything else is the host failing.
    if ([201, 400, 409, 413].includes(status)) return answer(response, status)
    log(`Bridge host ${claims.hostIds[0]} answered ${status} for an upload.`)
    refuse(502)
  }

  return async (request: IncomingMessage, response: ServerResponse, mediaId: string) => {
    if (request.method === 'PUT') return upload(request, response, mediaId)
    if (request.method !== 'GET') return answer(response, 405, { allow: 'GET, PUT' })
    if (!MEDIA_ID.test(mediaId)) return answer(response, 404)
    const claims = mediaClaims(bearer(request), options.gatewaySecret)
    if (!claims) return answer(response, 401)
    const person = claims.userId
    if (inFlight >= maxInFlight || (inFlightBy.get(person) ?? 0) >= maxPerPerson) {
      return answer(response, 503, { 'retry-after': '1' })
    }
    inFlight++
    inFlightBy.set(person, (inFlightBy.get(person) ?? 0) + 1)
    let done = false
    const finish = () => {
      if (done) return
      done = true
      inFlight--
      const left = (inFlightBy.get(person) ?? 1) - 1
      if (left > 0) inFlightBy.set(person, left)
      else inFlightBy.delete(person)
    }
    response.on('close', finish)

    let abort = () => {}
    response.on('close', () => abort())
    let unavailable = false
    for (const hostId of claims.hostIds) {
      const hostUrl = options.bridgeHosts.get(hostId)
      if (!hostUrl) continue
      if (response.destroyed) return finish()
      const asked = ask(hostUrl, mediaId, person, options.internalToken)
      abort = asked.abort
      let upstream: IncomingMessage
      try {
        upstream = await asked.answered
      } catch (error) {
        log(`Bridge host ${hostId} unreachable for a media request: ${describeError(error)}`)
        unavailable = true
        continue
      }
      // Not this host's, or not this person's: the next host may have it.
      if (upstream.statusCode === 404) {
        upstream.resume()
        continue
      }
      if (upstream.statusCode !== 200) {
        upstream.resume()
        log(`Bridge host ${hostId} answered ${upstream.statusCode} for a media request.`)
        unavailable = true
        continue
      }
      const length = upstream.headers['content-length']
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        ...(length ? { 'content-length': length } : {}),
        // Never from a cache: each fetch is checked for its own person and token, and a browser's
        // cache would hand one person's file to another signed in on it.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      upstream.on('error', () => response.destroy())
      upstream.pipe(response)
      return
    }
    answer(response, unavailable ? 502 : 404)
    finish()
  }
}
