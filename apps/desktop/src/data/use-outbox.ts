import type { BridgeStatus } from '~/data/bridge-ready.ts'
import { uploadFile } from '~/data/media.ts'
import { useSendMutations } from '~/data/messages.ts'
import { outbox, type Outbox } from '~/data/outbox.ts'
import { useSession } from '~/lib/session.tsx'

/** The signed-in person's outbox (outbox.ts), sending through Convex and the media upload. */
export function useOutbox(bridge: { key: string | undefined; status: BridgeStatus }): Outbox {
  const session = useSession()
  const { send, schedule, sendAgain } = useSendMutations()
  return outbox(
    { send, schedule, sendAgain, upload: (chatId, file) => uploadFile(session.userId, chatId, file) },
    { userId: session.userId, keyPair: session.keyPair, bridgeKey: bridge.key, bridgeStatus: bridge.status },
  )
}
