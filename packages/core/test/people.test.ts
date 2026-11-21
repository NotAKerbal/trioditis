import { describe, expect, it } from 'vitest'
import {
  cardFromContacts,
  groupUnlinked,
  moveLinks,
  normalPhone,
  parseIdentifier,
  planImport,
  samePhone,
  startIdentifier,
  suggestLinks,
  type NetworkContact,
  type Person,
} from '../src/index.ts'

const contact = (network: NetworkContact['network'], ghostId: string, name: string, identifiers: string[]) => ({
  network,
  ghostId,
  profile: { name },
  identifiers,
})

describe('phone numbers', () => {
  it('matches a number saved with or without its country code', () => {
    expect(samePhone('+1 (555) 123-4567', 'tel:+15551234567')).toBe(true)
    expect(samePhone('555-123-4567', '+15551234567')).toBe(true)
    expect(samePhone('1 555 123 4567', '+15551234567')).toBe(true)
    // A national trunk prefix isn't part of the international number.
    expect(samePhone('07700 900123', '+44 7700 900123')).toBe(true)
    expect(samePhone('030 1234567', '+49 30 1234567')).toBe(true)
    expect(samePhone('0044 7700 900123', '+447700900123')).toBe(true)
  })

  it('keeps different numbers apart', () => {
    expect(samePhone('+15551234567', '+15551234568')).toBe(false)
    // Two full international numbers must be equal, not just end alike.
    expect(samePhone('+15551234567', '+445551234567')).toBe(false)
    expect(samePhone('123', '+15550000123')).toBe(false)
    expect(samePhone('1-800-FLOWERS', '+18003569377')).toBe(false)
  })
})

describe('identifiers', () => {
  it('reads what networks report and what cards hold', () => {
    expect(parseIdentifier('tel:+15551234567')).toEqual({ kind: 'phone', value: '+15551234567' })
    expect(parseIdentifier('mailto:Ann@Example.com')).toEqual({ kind: 'email', value: 'ann@example.com' })
    expect(parseIdentifier('telegram:Alice')).toEqual({ kind: 'username', service: 'telegram', value: 'alice' })
    expect(parseIdentifier('https://x.com/alice_b')).toEqual({ kind: 'username', service: 'twitter', value: 'alice_b' })
    expect(parseIdentifier('@alice', 'instagram')).toEqual({ kind: 'username', service: 'instagram', value: 'alice' })
    expect(parseIdentifier('+44 7700 900123')).toEqual({ kind: 'phone', value: '+44 7700 900123' })
    expect(parseIdentifier('just words')).toBeNull()
  })
})

describe('link suggestions', () => {
  const ann: Person = {
    personKey: 'person-ann-000001',
    card: { name: 'Ann Lee', phones: [{ value: '(555) 123-4567' }], emails: [{ value: 'ann@example.com' }] },
  }
  const bob: Person = {
    personKey: 'person-bob-000001',
    card: { name: 'Bob Ray', handles: [{ value: 'telegram:bobray' }] },
  }

  it('suggests a card for a contact sharing a number, email, username or a unique name', () => {
    const contacts = [
      contact('whatsapp', 'g_wa_ann', 'Annie', ['tel:+15551234567']),
      contact('gvoice', 'g_gv_ann', 'Ann', ['mailto:ANN@example.com']),
      contact('telegram', 'g_tg_bob', 'B', ['telegram:BobRay']),
      contact('signal', 'g_sig_bob', 'Bob Ray', []),
      contact('signal', 'g_sig_zed', 'Zed', ['tel:+19995550000']),
    ]
    const suggestions = suggestLinks([ann, bob], contacts).map((s) => [s.contact.ghostId, s.personKey, s.reason])
    expect(suggestions).toEqual([
      ['g_wa_ann', ann.personKey, 'phone'],
      ['g_gv_ann', ann.personKey, 'email'],
      ['g_tg_bob', bob.personKey, 'username'],
      ['g_sig_bob', bob.personKey, 'name'],
    ])
  })

  it('leaves out contacts already on a card, and names more than one card has', () => {
    const linked: Person = { ...ann, card: { ...ann.card, links: [{ network: 'whatsapp', ghostId: 'g_wa_ann' }] } }
    const twin: Person = { personKey: 'person-ann-000002', card: { name: 'ann  lee' } }
    const contacts = [
      contact('whatsapp', 'g_wa_ann', 'Annie', ['tel:+15551234567']),
      contact('signal', 'g_s', 'Ann Lee', []),
    ]
    expect(suggestLinks([linked, twin], contacts)).toEqual([])
  })

  it('never matches on a shared profile’s handle, only on what the person’s logins know', () => {
    const shared = { network: 'whatsapp' as const, ghostId: 'g_old', profile: { name: 'A', handle: '+15551234567' } }
    expect(suggestLinks([ann], [shared])).toEqual([])
  })
})

describe('grouping and linking', () => {
  it('groups contacts on no card that share an identifier', () => {
    const a = contact('whatsapp', 'g1', 'Cy', ['tel:+15550001111'])
    const b = contact('signal', 'g2', 'Cy', ['tel:+15550001111', 'signal:cy.01'])
    const c = contact('telegram', 'g3', 'Cy T', ['telegram:cy'])
    const groups = groupUnlinked([], [a, b, c]).map((g) => g.map((x) => x.ghostId))
    expect(groups).toEqual([['g1', 'g2'], ['g3']])
  })

  it('makes one card from several contacts, keeping their identifiers', () => {
    const card = cardFromContacts([
      contact('whatsapp', 'g1', '', ['tel:+15550001111']),
      contact('signal', 'g2', 'Cy', ['tel:+15550001111', 'signal:cy.01']),
      contact('slack', 'g3', 'Cy', ['slack-internal:U123']),
    ])
    expect(card).toEqual({
      name: 'Cy',
      links: [
        { network: 'whatsapp', ghostId: 'g1' },
        { network: 'signal', ghostId: 'g2' },
        { network: 'slack', ghostId: 'g3' },
      ],
      phones: [{ value: '+15550001111' }],
      handles: [{ value: 'signal:cy.01' }],
    })
  })

  it('moves a contact off the card it was on', () => {
    const one: Person = {
      personKey: 'person-one-000001',
      card: { name: 'One', links: [{ network: 'signal', ghostId: 'g2' }] },
    }
    const two: Person = { personKey: 'person-two-000001', card: { name: 'Two' } }
    const changed = moveLinks([one, two], two.personKey, [contact('signal', 'g2', 'x', [])])
    expect(changed.map((p) => [p.personKey, p.card.links])).toEqual([
      [two.personKey, [{ network: 'signal', ghostId: 'g2' }]],
      [one.personKey, []],
    ])
  })

  it('never groups two different full numbers through one saved without its country code', () => {
    const us = contact('whatsapp', 'g1', 'A', ['tel:+12025550123'])
    const local = contact('signal', 'g2', 'B', ['tel:5550123'])
    const uk = contact('telegram', 'g3', 'C', ['tel:+44205550123'])
    expect(groupUnlinked([], [us, local, uk]).map((g) => g.map((c) => c.ghostId))).toEqual([['g1'], ['g2'], ['g3']])
  })
})

describe('importing again', () => {
  const existing: Person = {
    personKey: 'person-ann-000001',
    card: {
      name: 'Ann',
      uid: 'u1',
      note: 'old',
      photo: 'data:image/jpeg;base64,AAAA',
      addresses: [{ street: '1 Main St' }],
      links: [{ network: 'signal', ghostId: 'g1' }],
    },
  }
  const newKey = (index: number) => `person-new-${String(index).padStart(6, '0')}`

  it('updates a known card from the file without taking away its note, links or photo', () => {
    const file = { name: 'Ann Lee', uid: 'u1', note: 'new', addresses: [{ street: '1 Main St' }] }
    const plan = planImport([existing], [file, file], newKey)
    expect(plan).toEqual([{ personKey: existing.personKey, card: { ...existing.card, name: 'Ann Lee' } }])
    // Importing the same file again changes nothing.
    expect(planImport([{ personKey: existing.personKey, card: plan[0]!.card }], [file], newKey)).toEqual([])
  })

  it('works out the same cards again after another device changed them, keeping their links', () => {
    const file = [{ name: 'New One' }, { name: 'New Two' }]
    const first = planImport([], file, newKey)
    // Another device linked a contact to the first new card before the rest went in.
    const linked = { ...first[0]!, card: { ...first[0]!.card, links: [{ network: 'signal' as const, ghostId: 'g9' }] } }
    const again = planImport([linked], file, newKey)
    expect(again.map((p) => p.personKey)).toEqual([first[1]!.personKey])
  })

  it('makes one card for a UID the file repeats, and new cards for the rest', () => {
    const plan = planImport([], [{ name: 'X', uid: 'u2' }, { name: 'X2', uid: 'u2' }, { name: 'Y' }], newKey)
    expect(plan.map((p) => p.card.name)).toEqual(['X2', 'Y'])
    expect(new Set(plan.map((p) => p.personKey)).size).toBe(2)
  })
})

describe('reimporting a file without UIDs', () => {
  const newKey = (i: number) => `new-card-key-${String(i).padStart(4, '0')}`
  const otherKey = (i: number) => `other-key-${i}-0000000`
  const rows = [
    { name: 'Ann Lee', phones: [{ value: '+1 555 123 4567' }] },
    { name: 'Bob Stone', emails: [{ value: 'bob@example.com' }] },
  ]

  it('updates the cards the first import made instead of adding everyone again', () => {
    const first = planImport([], rows, newKey)
    expect(first).toHaveLength(2)
    const again = planImport(first, [{ ...rows[0]!, org: 'Acme' }, rows[1]!], otherKey)
    expect(again).toEqual([{ personKey: first[0]!.personKey, card: { ...rows[0]!, org: 'Acme' } }])
  })

  it('takes nothing away that was added here since, when an older export is imported again', () => {
    const here: Person = {
      personKey: 'person-ann-0000000',
      card: {
        name: 'Ann Lee',
        emails: [{ value: 'ann@example.com' }],
        phones: [{ value: '+15550001111', label: 'work' }],
        handles: [{ value: 'telegram:ann', label: 'Personal' }],
        note: 'Met at the conference',
        uid: 'vcf-1',
        links: [{ network: 'signal', ghostId: 'g1' }],
      },
    }
    const plan = planImport(
      [here],
      [{ name: 'Ann Lee', emails: [{ value: 'ANN@example.com' }, { value: 'a@old.example' }], note: 'old note' }],
      newKey,
    )
    expect(plan).toEqual([
      {
        personKey: here.personKey,
        card: { ...here.card, emails: [{ value: 'ann@example.com' }, { value: 'a@old.example' }] },
      },
    ])
  })

  it('matches by number written another way, and keeps the card’s UID and links', () => {
    const existing: Person = {
      personKey: 'person-ann-0000000',
      card: {
        name: 'ann lee',
        phones: [{ value: 'tel:+15551234567' }],
        uid: 'vcf-1',
        links: [{ network: 'signal', ghostId: 'g1' }],
      },
    }
    const plan = planImport(
      [existing],
      [{ name: 'Ann Lee', phones: [{ value: '+1 (555) 123-4567' }], note: 'hi' }],
      newKey,
    )
    expect(plan).toEqual([{ personKey: existing.personKey, card: { ...existing.card, name: 'Ann Lee', note: 'hi' } }])
  })

  it('never matches on a name alone', () => {
    const here: Person[] = [
      { personKey: 'person-a-00000000', card: { name: 'Sam', note: 'the plumber' } },
      { personKey: 'person-b-00000000', card: { name: 'Sam', note: 'from school' } },
    ]
    const plan = planImport(here, [{ name: 'Sam', org: 'Acme' }], newKey)
    expect(plan).toEqual([{ personKey: newKey(0), card: { name: 'Sam', org: 'Acme' } }])
  })

  it('keeps apart people who only share a name, and cards with their own different UIDs', () => {
    const existing: Person[] = [
      { personKey: 'person-ann-0000000', card: { name: 'Ann Lee', phones: [{ value: '+15551234567' }] } },
      { personKey: 'person-bob-0000000', card: { name: 'Bob', uid: 'a', emails: [{ value: 'b@x.co' }] } },
    ]
    const plan = planImport(
      existing,
      [
        { name: 'Ann Lee', phones: [{ value: '+15559999999' }] },
        { name: 'Bob', uid: 'b', emails: [{ value: 'b@x.co' }] },
      ],
      newKey,
    )
    expect(plan.map((p) => p.personKey)).toEqual([newKey(0), newKey(1)])
  })

  it('leaves out and reports an entry that could be either of two cards, whatever their order', () => {
    const a: Person = { personKey: 'zzzz-key-00000000', card: { name: 'Ann', emails: [{ value: 'ann@x.co' }] } }
    const b: Person = { personKey: 'aaaa-key-00000000', card: { name: 'Ann', emails: [{ value: 'ann@x.co' }] } }
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const skipped: number[] = []
      const plan = planImport(
        order,
        [{ name: 'Ann', emails: [{ value: 'ann@x.co' }], note: 'n' }],
        newKey,
        undefined,
        undefined,
        (i) => skipped.push(i),
      )
      expect(plan).toEqual([])
      expect(skipped).toEqual([0])
    }
  })

  it('matches each card once, so two rows that are the same don’t both land on it', () => {
    const here: Person = { personKey: 'person-ann-0000000', card: rows[0]! }
    const plan = planImport([here], [rows[0]!, { ...rows[0]!, org: 'Acme' }], newKey)
    expect(plan).toEqual([{ personKey: newKey(1), card: { ...rows[0]!, org: 'Acme' } }])
  })

  it('doesn’t match a card this same import made', () => {
    const first = planImport([], [rows[0]!, rows[0]!], newKey)
    // The first call wrote one; working the rest out again mustn't fold the second into it.
    const again = planImport(
      [first[0]!],
      [rows[0]!],
      () => newKey(1),
      undefined,
      (k) => k !== first[0]!.personKey,
    )
    expect(again.map((p) => p.personKey)).toEqual([newKey(1)])
  })
})

describe('typed phone numbers', () => {
  it('puts the ways people write numbers in one shape', () => {
    expect(normalPhone('+1 (555) 123-4567')).toBe('+15551234567')
    expect(normalPhone('(555) 123-4567')).toBe('5551234567')
    expect(normalPhone('555.123.4567')).toBe('5551234567')
    expect(normalPhone('tel:+1-555-123-4567')).toBe('+15551234567')
    expect(normalPhone('0044 7700 900123')).toBe('+447700900123')
    expect(normalPhone('+44 (0)20 7946 0958')).toBe('+442079460958')
    expect(normalPhone('+1\u00a0555\u2013123\u20134567')).toBe('+15551234567')
    expect(normalPhone('+1 555 123 4567 ext. 89')).toBe('+15551234567')
    expect(normalPhone('020 7946 0958')).toBe('02079460958')
  })

  it('isn’t fooled by what isn’t a number', () => {
    expect(normalPhone('1-800-FLOWERS')).toBeNull()
    expect(normalPhone('12345')).toBeNull()
    expect(normalPhone('+1234567890123456')).toBeNull()
    expect(normalPhone('alice')).toBeNull()
  })

  it('says why a chat can’t start from it, instead of sending it', () => {
    const both = { phone: true, username: true }
    expect(startIdentifier('(555) 123-4567', 'whatsapp', { phone: true, username: false })).toEqual({
      identifier: '5551234567',
    })
    expect(startIdentifier('(555) 123-4567', 'signal', both)).toEqual({ problem: 'needs_country_code' })
    expect(startIdentifier('+1 (555) 123-4567', 'signal', both)).toEqual({ identifier: '+15551234567' })
    expect(startIdentifier('@alice.01', 'signal', both)).toEqual({ identifier: 'alice.01' })
    expect(startIdentifier('alice', 'whatsapp', { phone: true, username: false })).toEqual({ problem: 'phone_only' })
    expect(startIdentifier('+15551234567', 'twitter', { phone: false, username: true })).toEqual({
      problem: 'username_only',
    })
    expect(startIdentifier('555-12', 'whatsapp', { phone: true, username: false })).toEqual({ problem: 'not_a_number' })
    // X usernames can be digits alone.
    expect(startIdentifier('12345', 'twitter', { phone: false, username: true })).toEqual({ identifier: '12345' })
  })

  it('gives the bridge host only what its phone pattern takes', () => {
    // apps/bridge-host/internal/connector/commands.go, phonePattern.
    const goPattern = /^\+?[0-9][0-9 ().-]{5,}[0-9]$/
    for (const raw of ['(555) 123-4567', 'tel:+1 555 123 4567', '0044 7700 900123', '+44 (0)20 7946 0958']) {
      expect(normalPhone(raw)).toMatch(goPattern)
    }
  })
})
