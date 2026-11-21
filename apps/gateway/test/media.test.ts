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
) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${payload}.${createHmac('sha256', secret).update(`media-access\n${payload}`).digest('base64url')}`
}

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

async function gateway(hosts: Record<string, string>, limits: { maxInFlightPerPerson?: number } = {}) {
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
