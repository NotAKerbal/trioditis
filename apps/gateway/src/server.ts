import { createServer, type IncomingMessage, type Server } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Backend } from './backend.ts'
import { handleEvents, type Reply } from './events.ts'
import { handleKeys } from './keys.ts'
import { describeError } from './log.ts'

// The gateway's internal HTTP API for bridge hosts. It listens only on the internal network.

const MAX_BODY_BYTES = 32 * 1024 * 1024

export interface ServerOptions {
  internalToken: string
  agentAccessPublicKey: string
  log?: (message: string) => void
}

function authorized(request: IncomingMessage, token: string) {
  const header = request.headers.authorization ?? ''
  const expected = Buffer.from(`Bearer ${token}`)
  const given = Buffer.from(header)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('Body too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function createGatewayServer(backend: Backend, options: ServerOptions): Server {
  const log = options.log ?? ((message) => console.log(message))
  return createServer(async (request, response) => {
    const reply = (result: Reply) => {
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.body))
    }
    const url = new URL(request.url ?? '/', 'http://gateway')
    if (request.method === 'GET' && url.pathname === '/healthz') return reply({ status: 200, body: { ok: true } })
    if (!authorized(request, options.internalToken)) return reply({ status: 401, body: { error: 'Unauthorized' } })

    try {
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        let body: unknown
        try {
          body = await readJson(request)
        } catch {
          return reply({ status: 400, body: { error: 'invalid_command' } })
        }
        return reply(await handleEvents(backend, body))
      }
      const keys = url.pathname.match(/^\/v1\/keys\/([^/]+)$/)
      if (request.method === 'GET' && keys) {
        return reply(await handleKeys(backend, options.agentAccessPublicKey, decodeURIComponent(keys[1]!)))
      }
      return reply({ status: 404, body: { error: 'Not found' } })
    } catch (error) {
      log(`${request.method} ${url.pathname} failed: ${describeError(error)}`)
      // The backend couldn't be reached. Nothing was acknowledged; the bridge host keeps the
      // events and tries again.
      return reply({ status: 503, body: { error: 'Backend unavailable' } })
    }
  })
}
