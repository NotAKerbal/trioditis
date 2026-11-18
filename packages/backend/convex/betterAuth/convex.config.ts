import { defineComponent } from 'convex/server'

// Better Auth's tables, installed in this project rather than from @convex-dev/better-auth,
// so plugins that add tables, such as passkeys, can add them.
const component = defineComponent('betterAuth')

export default component
