import { defineSchema } from 'convex/server'
import { tables } from './generatedSchema'

// Better Auth's tables as its CLI generates them for `createAuthOptions` in ../auth.ts. After
// changing those options, regenerate them from this folder with the CLI at the same minor
// version as better-auth: `npx auth@1.7 generate --output generatedSchema.ts`.
const schema = defineSchema({
  ...tables,
  // Signing in with a passkey looks it up by the credential the browser returns.
  passkey: tables.passkey.index('credentialID', ['credentialID']),
})

export default schema
