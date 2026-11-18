import { defineApp } from 'convex/server'
import mcp from '@convex-dev/mcp/convex.config.js'
import betterAuth from './betterAuth/convex.config'

const app = defineApp()
app.use(betterAuth)
app.use(mcp)

export default app
