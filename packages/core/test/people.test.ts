import { describe, expect, it } from 'vitest'
import {
  cardFromContacts,
  groupUnlinked,
  mergeCards,
  moveLinks,
  parseIdentifier,
  samePhone,
  suggestLinks,
  type NetworkContact,
  type Person,
} from '../src/index.ts'

const contact = (network: NetworkContact['network'], ghostId: string, name: string, identifiers: string[]) => ({
  network,
  ghostId,
  profile: { name, identifiers },
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

  it('falls back to the handle of a contact sent before identifiers were', () => {
    const old = { network: 'whatsapp' as const, ghostId: 'g_old', profile: { name: 'A', handle: '+15551234567' } }
    expect(suggestLinks([ann], [old]).map((s) => s.reason)).toEqual(['phone'])
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

  it('merges duplicate cards without repeating numbers', () => {
    const merged = mergeCards(
      { name: 'Ann', phones: [{ value: '+15551234567', label: 'mobile' }], note: 'a' },
      { name: 'Ann Lee', org: 'Acme', phones: [{ value: '555 123 4567' }, { value: '+15550000000' }], note: 'b' },
    )
    expect(merged).toEqual({
      name: 'Ann',
      org: 'Acme',
      phones: [{ value: '+15551234567', label: 'mobile' }, { value: '+15550000000' }],
      note: 'a\n\nb',
    })
  })
})
