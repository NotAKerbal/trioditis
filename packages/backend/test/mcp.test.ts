import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../convex/_generated/api'
import { MCP_HOST_STALE_MS, mcp } from '../convex/mcp'
import { GATEWAY_SECRET, heartbeat, setup, signIn, type T } from './setup'

// convex/mcp.ts reads its address as it loads, and this file imports it before setup() runs.
vi.hoisted(() => {
  process.env.SITE_URL = 'https://trioditis.test'
})

afterEach(() => {
  vi.useRealTimers()
})

const REDIRECT = 'http://127.0.0.1:4567/callback'
const VERIFIER = 'v'.repeat(43)

async function challengeOf(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** Registers an agent and starts its sign-in, as an MCP client does; returns the consent page's request ID. */
async function startConnect(t: T, scope?: string) {
  const registered = await t.fetch('/mcp/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Dots', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  })
  expect(registered.status).toBe(201)
  const { client_id: clientId } = (await registered.json()) as { client_id: string }
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await challengeOf(VERIFIER),
    code_challenge_method: 'S256',
    state: 'agent-state',
    ...(scope ? { scope } : {}),
  })
  const authorize = await t.fetch(`/mcp/oauth/authorize?${query}`, { redirect: 'manual' })
  const location = new URL(authorize.headers.get('Location')!)
  // The app's consent page (apps/desktop/src/routes/agents.connect.tsx), unless it's an error back to the agent.
  if (!location.searchParams.has('error'))
    expect(location.origin + location.pathname).toBe('https://trioditis.test/agents/connect')
  return { clientId, location, requestId: location.searchParams.get('request') }
}

async function tokenFor(t: T, clientId: string, redirectUrl: string) {
  const code = new URL(redirectUrl).searchParams.get('code')!
  const response = await t.fetch('/mcp/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      client_id: clientId,
    }).toString(),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { access_token: string }).access_token
}

async function callTool(t: T, token: string, name: string) {
  const response = await t.fetch('/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { result: { structuredContent?: unknown; isError?: boolean } }
}

async function connectAccount(t: T, userId: string, loginId: string, seq: number, network = 'whatsapp' as const) {
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: `${network}-1`,
    network,
    events: [{ seq, type: 'loginState', userId, loginId, at: Date.now(), state: 'CONNECTED' }],
  })
}

describe('MCP scopes', () => {
  it('advertises only scopes a tool uses, and passes its own lint', async () => {
    const t = setup()
    expect(mcp.lint()).toEqual([])
    const response = await t.fetch('/.well-known/oauth-authorization-server')
    expect(((await response.json()) as { scopes_supported: string[] }).scopes_supported).toEqual(['read'])
    const { location } = await startConnect(t, 'read send')
    expect(location.searchParams.get('error')).toBe('invalid_scope')
  })

  it('refuses to approve a request still waiting with a scope that was withdrawn', async () => {
    const t = setup()
    const alice = await signIn(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    const { clientId } = await startConnect(t)
    // As a request made before `send` was withdrawn was stored.
    await t.run(async (ctx) => {
      await ctx.runMutation(components.mcp.oauth.createAuthRequest, {
        requestId: 'old-request',
        clientId,
        redirectUri: REDIRECT,
        codeChallenge: await challengeOf(VERIFIER),
        scopes: ['read', 'send'],
        resource: 'https://trioditis.test/mcp',
        ttlMs: 60_000,
      })
    })
    await expect(
      alice.action(api.mcp.authorize, { requestId: 'old-request', approve: true, sessionId }),
    ).rejects.toThrow(/doesn’t offer yet/)
    expect(await alice.query(api.mcp.listConnections, {})).toEqual([])
    // Denying it still goes back to the agent.
    const { redirectUrl } = await alice.action(api.mcp.authorize, {
      requestId: 'old-request',
      approve: false,
      sessionId,
    })
    expect(new URL(redirectUrl!).searchParams.get('error')).toBe('access_denied')
  })
})

describe('agent consent', () => {
  it('shows the agent and its scopes, and approval connects it as the person who approved', async () => {
    const t = setup()
    const alice = await signIn(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    const { clientId, requestId } = await startConnect(t)
    expect(requestId).toMatch(/^mcp_req_[A-Za-z0-9_-]+$/)

    expect(await alice.query(api.mcp.getAuthRequest, { requestId: requestId! })).toMatchObject({
      kind: 'redirect',
      clientName: 'Dots',
      redirectUri: REDIRECT,
      status: 'pending',
      scopes: [{ name: 'read', description: expect.stringContaining('network') }],
    })
    const { redirectUrl } = await alice.action(api.mcp.authorize, { requestId: requestId!, approve: true, sessionId })
    const back = new URL(redirectUrl!)
    expect(back.origin + back.pathname).toBe(REDIRECT)
    expect(back.searchParams.get('state')).toBe('agent-state')

    // The connection is made once the agent trades the code for its token.
    const token = await tokenFor(t, clientId, redirectUrl!)
    const connections = await alice.query(api.mcp.listConnections, {})
    expect(connections).toEqual([
      expect.objectContaining({ kind: 'oauth', clientId, scopes: ['read'], createdAt: expect.any(Number) }),
    ])
    // Nobody else sees it.
    const bob = await signIn(t, 'bob')
    expect(await bob.query(api.mcp.listConnections, {})).toEqual([])
    expect(await bob.mutation(api.mcp.revokeConnection, { id: connections[0]!.id })).toBe(false)

    // The token acts as Alice.
    await connectAccount(t, 'alice', 'alice-wa', 1)
    await connectAccount(t, 'bob', 'bob-wa', 2)
    const result = await callTool(t, token, 'list_networks')
    expect(result.result.isError).toBeFalsy()
    const { networks } = result.result.structuredContent as { networks: { network: string }[] }
    expect(networks.map((n) => n.network)).toEqual(['whatsapp'])

    // Revoking disconnects it at once.
    expect(await alice.mutation(api.mcp.revokeConnection, { id: connections[0]!.id })).toBe(true)
    expect(await alice.query(api.mcp.listConnections, {})).toEqual([])
    const after = await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(after.status).toBe(401)
  })

  it('gives nothing to an agent whose person was removed between approving it and its first call', async () => {
    const t = setup()
    const alice = await signIn(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    const { clientId, requestId } = await startConnect(t)
    const { redirectUrl } = await alice.action(api.mcp.authorize, { requestId: requestId!, approve: true, sessionId })
    // Removed now: the approval was already given, and the component trades the code on its own.
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', 'alice'))
        .unique()
      await ctx.db.delete(member!._id)
    })
    const token = await tokenFor(t, clientId, redirectUrl!)
    const response = await t.fetch('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_networks', arguments: {} },
      }),
    })
    expect(response.status).toBe(401)
    // The connection it was given is gone too.
    expect(await t.query(components.mcp.grants.list, { userId: 'alice' })).toEqual([])
  })

  it('denies back to the agent without connecting it', async () => {
    const t = setup()
    const alice = await signIn(t, 'alice')
    const { sessionId } = (await alice.query(api.members.me, {}))!
    const { requestId } = await startConnect(t)
    const { redirectUrl } = await alice.action(api.mcp.authorize, { requestId: requestId!, approve: false, sessionId })
    expect(new URL(redirectUrl!).searchParams.get('error')).toBe('access_denied')
    expect(await alice.query(api.mcp.listConnections, {})).toEqual([])
    // A decided request can't be decided again.
    await expect(alice.action(api.mcp.authorize, { requestId: requestId!, approve: true, sessionId })).rejects.toThrow(
      /expired/,
    )
  })

  it('needs a signed-in member to approve', async () => {
    const t = setup()
    const { requestId } = await startConnect(t)
    await expect(t.action(api.mcp.authorize, { requestId: requestId!, approve: true })).rejects.toThrow(/Not signed in/)
  })
})

describe('list_networks', () => {
  it('tells accounts on one network apart, and says an account is live only while its bridge is', async () => {
    vi.useFakeTimers()
    const t = setup()
    await signIn(t, 'alice')
    await connectAccount(t, 'alice', 'alice-wa-1', 1)
    await connectAccount(t, 'alice', 'alice-wa-2', 2)
    const accounts = await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())

    const live = await t.query(internal.mcp.networksForUser, { userId: 'alice' })
    expect(live).toHaveLength(2)
    expect(new Set(live.map((n) => n.accountId))).toEqual(new Set(accounts.map((a) => a._id)))
    for (const account of live) {
      expect(account).toMatchObject({
        network: 'whatsapp',
        name: 'WhatsApp',
        state: 'CONNECTED',
        bridgeOnline: true,
        connected: true,
        disconnecting: false,
        connectedAt: expect.any(Number),
      })
      // Never the network's own login ID (a phone number, on some networks).
      expect(JSON.stringify(account)).not.toContain('alice-wa')
    }

    // The bridge host goes quiet: its last report says connected, but that's stale.
    vi.advanceTimersByTime(MCP_HOST_STALE_MS + 1000)
    const stale = await t.query(internal.mcp.networksForUser, { userId: 'alice' })
    expect(stale.map((n) => [n.state, n.bridgeOnline, n.connected])).toEqual([
      ['CONNECTED', false, false],
      ['CONNECTED', false, false],
    ])

    // It's heard from again.
    await heartbeat(t)
    expect((await t.query(internal.mcp.networksForUser, { userId: 'alice' })).every((n) => n.connected)).toBe(true)
  })
})
