import { createAuth } from '../auth'

// Only for generating `generatedSchema.ts` with Better Auth's CLI. Nothing imports it at
// runtime, where it would fail without the deployment's environment variables.
export const auth = createAuth({} as any)
