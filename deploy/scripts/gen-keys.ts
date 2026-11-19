// Prints the server's X25519 key pairs as env lines, with the same libsodium code the
// clients and bridge host use: the bridge key (clients seal outbound sends and login input
// to it) and the agent-access key (the MCP server opens granted chats with it).
// Run by install.sh, once, inside the node image.

import { generateKeyPair, ready, toBase64Url } from '@trioditis/crypto'

await ready()
for (const name of ['BRIDGE', 'AGENT_ACCESS']) {
  const pair = generateKeyPair()
  console.log(`${name}_PUBLIC_KEY=${toBase64Url(pair.publicKey)}`)
  console.log(`${name}_PRIVATE_KEY=${toBase64Url(pair.privateKey)}`)
}
