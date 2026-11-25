import { useAccounts, useNetworks } from '~/data/chats.ts'
import { ConnectList, type Login } from '~/features/settings/connect-list.tsx'
import { Group } from '~/features/settings/layout.tsx'

/** No account on any network yet, once that's known: the first-run guide shows. */
export function useFirstRun() {
  return useAccounts()?.length === 0
}

/**
 * The first-run guide, for someone with no account yet: the networks to connect, each starting
 * its login in Settings → Accounts. A wide window shows it where the open chat goes; a phone, in
 * the empty chat list (sidebar.tsx).
 */
export function FirstNetwork({ onChoose, onInstall }: { onChoose: (login: Login) => void; onInstall: () => void }) {
  // The list's box waits for the networks, rather than showing empty while they load.
  const networks = useNetworks()
  return (
    <div className="mx-auto w-full max-w-md">
      <h2 className="mb-3 px-1 text-lg font-bold">Connect your first network</h2>
      {networks ? (
        <Group>
          <ConnectList onChoose={onChoose} onInstall={onInstall} />
        </Group>
      ) : null}
    </div>
  )
}
