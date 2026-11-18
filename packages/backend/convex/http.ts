import { httpRouter } from 'convex/server'
import { authComponent, createAuth } from './auth'
import { mcp } from './mcp'

const http = httpRouter()

authComponent.registerRoutes(http, createAuth)
// /mcp, its OAuth endpoints under /mcp/oauth, and the OAuth discovery documents at /.well-known.
mcp.registerRoutes(http)

export default http
