import type { Id } from '@trioditis/backend/dataModel'
import type { Network } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { Input } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Segmented, SegmentedItem } from '@trioditis/ui/segmented'
import { useState } from 'react'
import { networkName } from '~/data/chats.ts'
import { identifierPrompt, newChatChoice, useStartableAccounts, useStartChat } from '~/data/new-chat.ts'

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
  const [chosen, setChosen] = useState<Network | undefined>()
  const [chosenAccount, setChosenAccount] = useState<Id<'networkAccounts'> | undefined>()
  const { networks, network, accounts, account } = newChatChoice(useStartableAccounts(), chosen, chosenAccount)
  const [value, setValue] = useState('')
  const start = useStartChat(onStarted)

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        const identifier = value.trim()
        if (network && account && identifier) void start.begin(network, account.networkAccountId, { identifier })
      }}
    >
      <DialogTitle className="text-md">New chat</DialogTitle>
      {!network ? (
        <p className="text-sm text-muted-foreground">
          None of your connected accounts can start a chat from a phone number or username.
        </p>
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
          {accounts.length > 1 ? (
            // Each login is its own identity on the network: the person says which one to use.
            <Segmented
              value={account?.networkAccountId ?? ''}
              onValueChange={(id) => setChosenAccount(id as Id<'networkAccounts'>)}
              aria-label={`Which ${networkName(network)} account`}
            >
              {accounts.map((a) => (
                <SegmentedItem key={a.networkAccountId} value={a.networkAccountId} className="min-w-0 truncate px-2">
                  {a.detail}
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
          <Button type="submit" variant="primary" block loading={start.busy} disabled={!value.trim() || !account}>
            {account
              ? `Start chat on ${networkName(network)}${account.detail ? ` (${account.detail})` : ''}`
              : `Choose which ${networkName(network)} account`}
          </Button>
        </>
      )}
    </form>
  )
}
