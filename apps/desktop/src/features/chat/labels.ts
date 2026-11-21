import type { Label } from '~/data/chats.ts'
import { sealLabel, type LabelColor } from '~/lib/sealed.ts'
import type { Session } from '~/lib/session.tsx'

/** The longest label name the editor takes. */
export const MAX_LABEL_NAME = 40

/** A label's name as it's saved: trimmed, and null when there's nothing left to save. */
export function labelName(name: string): string | null {
  const trimmed = name.trim().slice(0, MAX_LABEL_NAME)
  return trimmed || null
}

/**
 * A label's new name and colour, sealed as `labels.update` takes it: to the person, under the
 * label's own key, so chats that carry it keep it and the server sees neither.
 */
export function renamedLabel(
  label: Pick<Label, 'id' | 'labelKey'>,
  name: string,
  color: LabelColor,
  session: Pick<Session, 'userId' | 'keyPair'>,
) {
  const saved = labelName(name)
  if (!saved) return null
  return {
    labelId: label.id,
    sealed: sealLabel({ name: saved, color }, label.labelKey, session.userId, session.keyPair.publicKey),
  }
}
