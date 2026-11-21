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

/** A media ID as the bridge host makes them: 128 random bits, base64url. */
const MEDIA_ID = /^[A-Za-z0-9_-]{16,64}$/
const MAX_HOSTS = 8
/** Files being passed along at once, and for one person: a chat's pictures load a few at a time. */
const MAX_IN_FLIGHT = 64
const MAX_IN_FLIGHT_PER_PERSON = 16
/** How long a bridge host has to start answering. */
const HOST_TIMEOUT_MS = 15_000

export interface MediaOptions {
  internalToken: string
  /** GATEWAY_SECRET, which Convex signs media tokens with. */
  gatewaySecret: string
  /** Where each bridge host takes requests, by host ID: the token names hosts, never their addresses. */
  bridgeHosts: Map<string, string>
  log?: (message: string) => void
  maxInFlight?: number
  maxInFlightPerPerson?: number
}

export interface MediaClaims {
  userId: string
  hostIds: string[]
}

/**
 * Who a media token (`<payload>.<mac>`) was signed for and the hosts it names, or null for one
 * that isn't Convex's or has expired.
 */
export function mediaClaims(token: string, secret: string, now = Date.now()): MediaClaims | null {
  const [payload, mac, ...rest] = token.split('.')
  if (rest.length > 0 || !payload || !mac || payload.length > 2048) return null
  const expected = createHmac('sha256', secret).update(`media-access\n${payload}`).digest()
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

export function createMediaHandler(options: MediaOptions) {
  const log = options.log ?? ((message) => console.log(message))
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT
  const maxPerPerson = options.maxInFlightPerPerson ?? MAX_IN_FLIGHT_PER_PERSON
  let inFlight = 0
  const inFlightBy = new Map<string, number>()

  const answer = (response: ServerResponse, status: number, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-length': '0', 'cache-control': 'no-store', ...headers })
    response.end()
  }

  return async (request: IncomingMessage, response: ServerResponse, mediaId: string) => {
    if (request.method !== 'GET') return answer(response, 405, { allow: 'GET' })
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
