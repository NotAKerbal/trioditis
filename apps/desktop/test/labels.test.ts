import { generateKeyPair, openJson, ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { LabelId } from '../src/data/chats.ts'
import { labelName, MAX_LABEL_NAME, renamedLabel } from '../src/features/chat/labels.ts'

beforeAll(ready)

describe('renaming a label', () => {
  it('seals the new name and colour under the label’s own key, for its owner only', () => {
    const keyPair = generateKeyPair()
    const label = { id: 'l1' as LabelId, labelKey: 'abcdefabcdefabcdef12' }
    const renamed = renamedLabel(label, '  Family  ', 'green', { userId: 'u1', keyPair })!
    expect(renamed.labelId).toBe('l1')
    expect(JSON.stringify(renamed.sealed)).not.toContain('Family')
    const opened = openJson(renamed.sealed, keyPair, { kind: 'label', ownerUserId: 'u1', objectId: label.labelKey })
    expect(opened).toEqual({ name: 'Family', color: 'green' })
    expect(() =>
      openJson(renamed.sealed, keyPair, { kind: 'label', ownerUserId: 'u1', objectId: 'other-key-123456' }),
    ).toThrow()
  })

  it('refuses an empty name and keeps a long one to the limit', () => {
    const keyPair = generateKeyPair()
    expect(
      renamedLabel({ id: 'l1' as LabelId, labelKey: 'abcdefabcdefabcdef12' }, '   ', 'blue', { userId: 'u1', keyPair }),
    ).toBeNull()
    expect(labelName('x'.repeat(60))).toHaveLength(MAX_LABEL_NAME)
    expect(labelName(' Work ')).toBe('Work')
  })
})
