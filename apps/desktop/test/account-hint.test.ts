import { generateKeyPair, keyId, ready, sealJson } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { openAccountHint } from '../src/data/chats.ts'
import type { Session } from '../src/lib/session.tsx'

// The bridge host's login IDs are keyed hashes, so the backend's hint is only the end of one;
// the account's number comes sealed to the person, as logins.accounts gives it.
describe('an account’s hint', () => {
  beforeAll(ready)

  const setup = () => {
    const keyPair = generateKeyPair()
    const session: Session = {
      userId: 'user_a',
      sessionId: 's',
      role: 'member',
      kid: keyId(keyPair.publicKey),
      keyPair,
    }
    const loginId = 'l_Q2x9aZ0bXy4mN7pR3sT1uV'
    const sealed = sealJson({ hint: '+15551234567' }, [{ publicKey: keyPair.publicKey }], {
      kind: 'account',
      ownerUserId: 'user_a',
      objectId: loginId,
    })
    const row = { hint: 'ID …T1uV', sealedMeta: { sealed, objectId: loginId } }
    return { session, row }
  }

  it('shows the number the bridge host sealed', () => {
    const { session, row } = setup()
    expect(openAccountHint(row as never, session)).toBe('+15551234567')
  })

  it('falls back to the end of the ID where there is none, or it won’t open', () => {
    const { session, row } = setup()
    expect(openAccountHint({ ...row, sealedMeta: null } as never, session)).toBe('ID …T1uV')
    // Presented as another account's: its associated data doesn't match.
    expect(openAccountHint({ ...row, sealedMeta: { ...row.sealedMeta, objectId: 'l_other' } } as never, session)).toBe(
      'ID …T1uV',
    )
  })
})
