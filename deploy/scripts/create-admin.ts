// Creates the admin account with the installer's setup token, as the app's setup screen does:
// the password the server gets is derived from the one given (authPassword), so the account
// signs in from the app and from apps/gateway/scripts/e2e-fake.ts. For installs whose web app
// isn't built in yet. Run by `deploy/trioditis create-admin <email>`, inside the node image,
// with the password in TRIODITIS_ADMIN_PASSWORD; it prints no secret.
//
// It goes straight to the backend's HTTP actions, where Caddy sends /api/auth/*, so it works
// the same in every mode (a domain install's Caddy only answers HTTPS for its name).

import { authPassword, ready } from '@trioditis/crypto'

const email = process.argv[2]?.trim()
const password = process.env.TRIODITIS_ADMIN_PASSWORD ?? ''
const site = process.env.SITE_URL
const setupToken = process.env.TRIODITIS_SETUP_TOKEN
if (!email || !email.includes('@')) throw new Error('Usage: create-admin.ts <email>')
if (password.length < 12) {
  console.error('create-admin: the password needs 12 or more characters')
  process.exit(1)
}
if (!site || !setupToken) {
  console.error('create-admin: SITE_URL and TRIODITIS_SETUP_TOKEN are needed (run it through deploy/trioditis)')
  process.exit(1)
}

await ready()
const response = await fetch('http://backend:3211/api/auth/sign-up/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: site, 'x-trioditis-invite': setupToken },
  body: JSON.stringify({ name: email.split('@')[0], email, password: authPassword(password, email) }),
})
if (!response.ok) {
  const body = (await response.json().catch(() => ({}))) as { message?: string }
  console.error(
    `create-admin: the account wasn't created (${response.status}${body.message ? `: ${body.message}` : ''}).`,
  )
  console.error('The setup token works once: if an account already exists, invite people from the app instead.')
  process.exit(1)
}
console.log(`create-admin: created the admin account ${email}. Sign in with it from the app.`)
