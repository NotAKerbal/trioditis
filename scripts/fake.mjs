// Delivers a message on the fake network, as if someone sent it, to this checkout's running
// dev instance (`pnpm dev`). Connect the fake network first, with any username.
//
//   pnpm fake <username> <from> "<text>"            a direct message from <from>
//   pnpm fake <username> <from> "<text>" --chat <id> into a group chat <id>
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { dataDir } from './lib.mjs'

const args = process.argv.slice(2)
const chatFlag = args.indexOf('--chat')
const chat = chatFlag >= 0 ? args.splice(chatFlag, 2)[1] : undefined
const [username, from, text] = args
if (!username || !from || !text) {
  console.error('Usage: pnpm fake <username> <from> "<text>" [--chat <id>]')
  process.exit(1)
}

let envText
try {
  envText = readFileSync(resolve(dataDir, 'dev.env'), 'utf8')
} catch {
  console.error('No dev instance in this checkout yet. Run `pnpm dev` first.')
  process.exit(1)
}
const env = Object.fromEntries(
  envText
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
)

const response = await fetch(`http://${env.BRIDGE_FAKE_CONTROL_ADDR}/fake/incoming`, {
  method: 'POST',
  headers: { authorization: `Bearer ${env.TRIODITIS_INTERNAL_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    loginId: username,
    chatId: chat ?? `dm-${from}`,
    senderId: from,
    messageId: randomUUID(),
    text,
  }),
}).catch(() => null)
if (!response) {
  console.error('The fake network isn’t running. Start it with `pnpm dev`.')
  process.exit(1)
}
if (response.status !== 202) {
  console.error(
    `The fake network refused it (${response.status}). Is "${username}" the username you connected it with?`,
  )
  process.exit(1)
}
console.log(`Delivered to ${username} from ${from}.`)
