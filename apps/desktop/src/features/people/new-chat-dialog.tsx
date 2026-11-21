import type { Id } from '@trioditis/backend/dataModel'
import type { Network } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { useState } from 'react'
import { networkName } from '~/data/chats.ts'
import { identifierPrompt, useStartableAccounts, useStartChat } from '~/data/new-chat.ts'

/** Starts a chat with a phone number or username on one of the person's networks. */
export function NewChatDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (chatId: Id<'chats'>) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(440px,calc(100vw-32px))] p-6" aria-describedby={undefined}>
        {open ? <NewChat onStarted={onStarted} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function NewChat({ onStarted }: { onStarted: (chatId: Id<'chats'>) => void }) {
  // The first account on each network that can start from a number or username.
  const accounts = new Map<Network, Id<'networkAccounts'>>()
  for (const a of useStartableAccounts()) {
    if (identifierPrompt(a.network) && !accounts.has(a.network)) accounts.set(a.network, a.networkAccountId)
  }
  const networks = [...accounts.keys()]
  const [chosen, setChosen] = useState<Network | undefined>()
  const network = chosen && accounts.has(chosen) ? chosen : networks[0]
  const [value, setValue] = useState('')
  const start = useStartChat(onStarted)

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const identifier = value.trim()
        if (network && identifier) void start.begin(network, accounts.get(network)!, { identifier })
      }}
    >
      <DialogTitle className="text-md">New chat</DialogTitle>
      {!network ? (
        <p className="text-sm text-muted-foreground">Connect a network that can start chats first.</p>
      ) : (
        <>
          {networks.length > 1 ? (
            <Segmented value={network} onValueChange={(n) => setChosen(n as Network)} aria-label="Network">
              {networks.map((n) => (
                <SegmentedItem
                  key={n}
                  value={n}
                  aria-label={networkName(n)}
                  className="flex items-center justify-center"
                >
                  <NetworkBadge network={n} label={networkName(n)} size={16} />
                </SegmentedItem>
              ))}
            </Segmented>
          ) : null}
          <Input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              start.clearError()
            }}
            placeholder={identifierPrompt(network) ?? ''}
            aria-label={`Who to message on ${networkName(network)}`}
            aria-invalid={start.error ? true : undefined}
          />
          {start.error ? (
            <p role="alert" className="text-sm text-danger">
              {start.error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" block loading={start.busy} disabled={!value.trim()}>
            Start chat on {networkName(network)}
          </Button>
        </>
      )}
    </form>
  )
}
