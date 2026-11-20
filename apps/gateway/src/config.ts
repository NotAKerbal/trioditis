// The gateway's settings, from the environment. See .env.example.

export interface Config {
  convexUrl: string
  gatewaySecret: string
  internalToken: string
  listen: { host: string; port: number }
  /** Where the sign-in browser's websocket is served, behind Caddy (signin-browser.md). */
  publicListen: { host: string; port: number }
  agentAccessPublicKey: string
  /** Where each bridge host takes commands, by host ID. Never taken from what a host says. */
  bridgeHosts: Map<string, string>
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. See apps/gateway/.env.example.`)
  return value
}

/** `whatsapp-1=http://127.0.0.1:8611,signal-1=http://127.0.0.1:8612` */
export function parseBridgeHosts(value: string): Map<string, string> {
  const hosts = new Map<string, string>()
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [hostId, url] = entry.split('=', 2)
    if (!hostId || !url || !/^https?:\/\/[^/]+$/.test(url)) {
      throw new Error(`BRIDGE_HOSTS entry "${entry}" isn't <hostId>=<http(s)://host:port>`)
    }
    hosts.set(hostId, url)
  }
  return hosts
}

/** `host:port`, from an environment variable, with the defaults for what it leaves out. */
function address(value: string | undefined, defaultPort: number) {
  const [host = '127.0.0.1', port = String(defaultPort)] = (value ?? `127.0.0.1:${defaultPort}`).split(':')
  return { host, port: Number(port) }
}

export function loadConfig(): Config {
  return {
    convexUrl: required('CONVEX_URL'),
    gatewaySecret: required('GATEWAY_SECRET'),
    internalToken: required('TRIODITIS_INTERNAL_TOKEN'),
    listen: address(process.env.GATEWAY_INTERNAL_ADDR, 8601),
    publicListen: address(process.env.GATEWAY_PUBLIC_ADDR, 8602),
    agentAccessPublicKey: required('AGENT_ACCESS_PUBLIC_KEY'),
    bridgeHosts: parseBridgeHosts(required('BRIDGE_HOSTS')),
  }
}
