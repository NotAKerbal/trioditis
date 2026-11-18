import { ConvexClient, ConvexHttpClient } from 'convex/browser'
import { api } from '@trioditis/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'

// The gateway's view of the Convex backend, as an interface so the pipeline can be tested
// without a deployment.

type Gateway = typeof api.gateway
type Args<F extends keyof Gateway> = Omit<FunctionArgs<Gateway[F]>, 'secret'>
type Result<F extends keyof Gateway> = FunctionReturnType<Gateway[F]>

export interface Backend {
  ingest(args: Args<'ingest'>): Promise<Result<'ingest'>>
  recipientKeys(args: Args<'recipientKeys'>): Promise<Result<'recipientKeys'>>
  hosts(): Promise<Result<'hosts'>>
  claimCommands(args: Args<'claimCommands'>): Promise<Result<'claimCommands'>>
  commandResult(args: Args<'commandResult'>): Promise<Result<'commandResult'>>
  /**
   * Calls `onChange` whenever the set of queued commands changes, and `onError` if the
   * subscription fails (it keeps retrying). Returns an unsubscribe.
   */
  watchPendingCommands(onChange: () => void, onError: (error: Error) => void): () => void
  close(): Promise<void>
}

export type ClaimedCommand = Result<'claimCommands'>[number]

export function convexBackend(url: string, secret: string): Backend {
  const http = new ConvexHttpClient(url)
  const live = new ConvexClient(url)
  return {
    ingest: (args) => http.mutation(api.gateway.ingest, { secret, ...args }),
    recipientKeys: (args) => http.query(api.gateway.recipientKeys, { secret, ...args }),
    hosts: () => http.query(api.gateway.hosts, { secret }),
    claimCommands: (args) => http.mutation(api.gateway.claimCommands, { secret, ...args }),
    commandResult: (args) => http.mutation(api.gateway.commandResult, { secret, ...args }),
    watchPendingCommands: (onChange, onError) =>
      live.onUpdate(api.gateway.pendingCommands, { secret }, onChange, onError),
    close: () => live.close(),
  }
}
