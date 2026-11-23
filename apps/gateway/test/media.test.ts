import { createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createMediaHandler, mediaClaims } from '../src/media.ts'
import { createSigninServer } from '../src/signin.ts'

const TOKEN = 'internal-token'
const SECRET = 'gateway-secret'
const MEDIA_ID = 'AAAAAAAAAAAAAAAAAAAAAA'

/** A media token as Convex signs it (packages/backend/convex/media.ts). */
function token(
  claims: { u: string; h: string[]; e: number } = { u: 'user_a', h: ['meta-1'], e: Date.now() + 60_000 },
  secret = SECRET,
  purpose = 'media-access',
) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(`${purpose}\n${payload}`).digest('base64url')}`
}

/** An upload token for one host (packages/backend/convex/media.ts, upload). */
const uploadToken = (claims = { u: 'user_a', h: ['meta-1'], e: Date.now() + 60_000 }) =>
  token(claims, SECRET, 'media-upload')

const servers: Server[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A bridge host with one person's file. */
async function fakeHost(files: Record<string, string> = { [`${MEDIA_ID}/user_a`]: 'ciphertext' }, status?: number) {
  const seen: { url?: string; headers?: IncomingHttpHeaders }[] = []
  const url = await listen(
    createServer((request, response) => {
      seen.push({ url: request.url!, headers: request.headers })
      const id = request.url!.replace('/v1/media/', '')
      const file = files[`${id}/${String(request.headers['x-trioditis-user-id'])}`]
      if (status) response.writeHead(status).end()
      else if (request.headers.authorization !== `Bearer ${TOKEN}` || file === undefined) response.writeHead(404).end()
      else response.writeHead(200, { 'content-length': String(file.length) }).end(file)
    }),
  )
  return { url, seen }
}

async function gateway(
  hosts: Record<string, string>,
  limits: { maxInFlightPerPerson?: number; maxUploadBytes?: number } = {},
) {
  const bridgeHosts = new Map(Object.entries(hosts))
  const media = createMediaHandler({
    internalToken: TOKEN,
    gatewaySecret: SECRET,
    bridgeHosts,
    log: () => {},
    ...limits,
  })
  const server = createSigninServer(
    { redeemSigninTicket: async () => null },
    { internalToken: TOKEN, gatewaySecret: SECRET, bridgeHosts, media, log: () => {} },
  )
  return await listen(server)
}

const get = (base: string, path: string, auth?: string) =>
  fetch(base + path, auth ? { headers: { authorization: `Bearer ${auth}` } } : {})

describe('media tokens', () => {
  it('takes only a live token Convex signed', () => {
    expect(mediaClaims(token(), SECRET)).toEqual({ userId: 'user_a', hostIds: ['meta-1'] })
    expect(mediaClaims(token(undefined, 'another'), SECRET)).toBeNull()
    expect(mediaClaims(token({ u: 'user_a', h: [], e: Date.now() - 1 }), SECRET)).toBeNull()
    expect(mediaClaims(token({ u: '', h: [], e: Date.now() + 1000 }), SECRET)).toBeNull()
    expect(mediaClaims(`${token()}.x`, SECRET)).toBeNull()
    expect(mediaClaims('', SECRET)).toBeNull()
  })
})

describe('GET /media/:id', () => {
  it('passes the owner’s ciphertext along from the host that has it', async () => {
    const empty = await fakeHost({})
    const host = await fakeHost()
    const base = await gateway({ 'meta-0': empty.url, 'meta-1': host.url })
    const response = await get(
      base,
      `/media/${MEDIA_ID}`,
      token({ u: 'user_a', h: ['meta-0', 'meta-1'], e: Date.now() + 60_000 }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ciphertext')
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('cache-control')).toBe('no-store')
    // Only the internal token and the person go to the host; nothing of the client's request.
    expect(host.seen[0]!.url).toBe(`/v1/media/${MEDIA_ID}`)
    expect(host.seen[0]!.headers!.authorization).toBe(`Bearer ${TOKEN}`)
    expect(host.seen[0]!.headers!['x-trioditis-user-id']).toBe('user_a')
  })

  it('refuses a missing or forged token, and asks no host', async () => {
    const host = await fakeHost()
    const base = await gateway({ 'meta-1': host.url })
    expect((await get(base, `/media/${MEDIA_ID}`)).status).toBe(401)
    expect((await get(base, `/media/${MEDIA_ID}`, token(undefined, 'another'))).status).toBe(401)
    expect(host.seen).toHaveLength(0)
  })

  it('finds nothing for someone else, or a malformed ID', async () => {
    const host = await fakeHost()
    const base = await gateway({ 'meta-1': host.url })
    const bob = token({ u: 'user_b', h: ['meta-1'], e: Date.now() + 60_000 })
    expect((await get(base, `/media/${MEDIA_ID}`, bob)).status).toBe(404)
    expect((await get(base, '/media/..%2F..%2Fetc', token())).status).toBe(404)
    expect((await get(base, '/media/short', token())).status).toBe(404)
  })

  it('only asks hosts in its own configuration', async () => {
    const host = await fakeHost()
    const base = await gateway({})
    const response = await get(
      base,
      `/media/${MEDIA_ID}`,
      token({ u: 'user_a', h: [host.url], e: Date.now() + 60_000 }),
    )
    expect(response.status).toBe(404)
    expect(host.seen).toHaveLength(0)
  })

  it('says a host that fails is unavailable', async () => {
    const host = await fakeHost({}, 500)
    const base = await gateway({ 'meta-1': host.url })
    expect((await get(base, `/media/${MEDIA_ID}`, token())).status).toBe(502)
  })
})

/** A bridge host that keeps what it's given, once per ID and person. */
async function keepingHost(status?: number) {
  const kept = new Map<string, string>()
  const seen: { url: string; headers: IncomingHttpHeaders }[] = []
  const url = await listen(
    createServer((request, response) => {
      seen.push({ url: request.url!, headers: request.headers })
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const key = `${request.url}/${String(request.headers['x-trioditis-user-id'])}`
        if (status) return response.writeHead(status).end()
        if (request.method !== 'PUT' || request.headers.authorization !== `Bearer ${TOKEN}`) {
          return response.writeHead(401).end()
        }
        if (kept.has(key)) return response.writeHead(409).end()
        kept.set(key, Buffer.concat(chunks).toString())
        response.writeHead(201).end()
      })
    }),
  )
  return { url, kept, seen }
}

const putFile = (base: string, path: string, body: string, auth?: string) =>
  fetch(base + path, { method: 'PUT', body, ...(auth ? { headers: { authorization: `Bearer ${auth}` } } : {}) })

describe('PUT /media/:id', () => {
  it('gives the file to the one host the upload token names, for its person', async () => {
    const host = await keepingHost()
    const base = await gateway({ 'meta-1': host.url })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'ciphertext', uploadToken())).status).toBe(201)
    expect(host.kept.get(`/v1/media/${MEDIA_ID}/user_a`)).toBe('ciphertext')
    expect(host.seen[0]!.headers['content-length']).toBe('10')
    // The same ID again is the host's to refuse.
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'other', uploadToken())).status).toBe(409)
  })

  it('refuses a fetch token, a forged one, or one naming several hosts', async () => {
    const host = await keepingHost()
    const base = await gateway({ 'meta-1': host.url, 'meta-2': host.url })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'x')).status).toBe(401)
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'x', token())).status).toBe(401)
    const several = uploadToken({ u: 'user_a', h: ['meta-1', 'meta-2'], e: Date.now() + 60_000 })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'x', several)).status).toBe(503)
    const unknown = uploadToken({ u: 'user_a', h: ['meta-9'], e: Date.now() + 60_000 })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'x', unknown)).status).toBe(503)
    expect((await putFile(base, '/media/short', 'x', uploadToken())).status).toBe(404)
    expect(host.seen).toHaveLength(0)
  })

  it('turns away a file too large before any of it goes on', async () => {
    const host = await keepingHost()
    const base = await gateway({ 'meta-1': host.url }, { maxUploadBytes: 4 })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'too large', uploadToken())).status).toBe(413)
    expect(host.seen).toHaveLength(0)
  })

  it('says a host that fails is unavailable', async () => {
    const host = await keepingHost(500)
    const base = await gateway({ 'meta-1': host.url })
    expect((await putFile(base, `/media/${MEDIA_ID}`, 'x', uploadToken())).status).toBe(502)
  })
})
