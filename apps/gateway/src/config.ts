// The gateway's settings, from the environment. See .env.example.

export interface Config {
  convexUrl: string
  gatewaySecret: string
  internalToken: string
  listen: { host: string; port: number }
  agentAccessPublicKey: string
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. See apps/gateway/.env.example.`)
  return value
}

export function loadConfig(): Config {
  const [host = '127.0.0.1', port = '8601'] = (process.env.GATEWAY_INTERNAL_ADDR ?? '127.0.0.1:8601').split(':')
  return {
    convexUrl: required('CONVEX_URL'),
    gatewaySecret: required('GATEWAY_SECRET'),
    internalToken: required('TRIODITIS_INTERNAL_TOKEN'),
    listen: { host, port: Number(port) },
    agentAccessPublicKey: required('AGENT_ACCESS_PUBLIC_KEY'),
  }
}
