import { ready } from '@trioditis/crypto'
import { convexBackend } from './backend.ts'
import { loadConfig } from './config.ts'
import { Dispatcher } from './dispatcher.ts'
import { createGatewayServer } from './server.ts'

await ready()
const config = loadConfig()
const backend = convexBackend(config.convexUrl, config.gatewaySecret)
const server = createGatewayServer(backend, {
  internalToken: config.internalToken,
  agentAccessPublicKey: config.agentAccessPublicKey,
})
const dispatcher = new Dispatcher(backend, { internalToken: config.internalToken })

server.listen(config.listen.port, config.listen.host, () => {
  console.log(`Gateway listening on ${config.listen.host}:${config.listen.port}`)
  dispatcher.start()
})

async function shutdown() {
  dispatcher.stop()
  server.close()
  await backend.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
