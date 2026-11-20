import { ready } from '@trioditis/crypto'
import { convexBackend } from './backend.ts'
import { loadConfig } from './config.ts'
import { Dispatcher } from './dispatcher.ts'
import { createGatewayServer } from './server.ts'
import { createSigninServer } from './signin.ts'

await ready()
const config = loadConfig()
const backend = convexBackend(config.convexUrl, config.gatewaySecret)
const server = createGatewayServer(backend, {
  internalToken: config.internalToken,
  agentAccessPublicKey: config.agentAccessPublicKey,
})
const signin = createSigninServer(backend, {
  internalToken: config.internalToken,
  gatewaySecret: config.gatewaySecret,
  bridgeHosts: config.bridgeHosts,
})
const dispatcher = new Dispatcher(backend, { internalToken: config.internalToken, bridgeHosts: config.bridgeHosts })

server.listen(config.listen.port, config.listen.host, () => {
  console.log(`Gateway listening on ${config.listen.host}:${config.listen.port}`)
  dispatcher.start()
})
signin.listen(config.publicListen.port, config.publicListen.host, () => {
  console.log(`Gateway serving the sign-in browser on ${config.publicListen.host}:${config.publicListen.port}`)
})

async function shutdown() {
  dispatcher.stop()
  server.close()
  signin.close()
  await backend.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
