import { describe, expect, it } from 'vitest'
import { MAX_IMPORT_CARDS, parseContactsCsv, parseContactsFile, parseVCards, toVCards } from '../src/index.ts'

describe('vCard', () => {
  it('reads an iPhone export: groups, Apple labels, folded lines, photos and no-year birthdays', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:3.0',
      'PRODID:-//Apple Inc.//iPhone OS 18.0//EN',
      'N:Lee;Ann;Q;Dr.;',
      'FN:Dr. Ann Q Lee',
      'ORG:Acme;Research',
      'TITLE:Chemist',
      'item1.TEL;type=pref:+1 (555) 123-4567',
      'item1.X-ABLabel:_$!<Mobile>!$_',
      'item2.TEL:+44 7700 900123',
      'item2.X-ABLabel:Boat',
      'TEL;type=HOME;type=VOICE:555 000 1111',
      'EMAIL;type=INTERNET;type=WORK:ann@acme.example',
      'X-SOCIALPROFILE;type=twitter;x-user=annlee:https://twitter.com/annlee',
      'IMPP;X-SERVICE-TYPE=Telegram:telegram:ann_l',
      'ADR;type=HOME:;;1 Main St\\nApt 2;Springfield;IL;62701;USA',
      'BDAY;X-APPLE-OMIT-YEAR=1604:1604-05-01',
      'NOTE:Met at the\\, conference\\nTwice',
      'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ',
      ' SkZJRg==',
      'UID:abc-123',
      'END:VCARD',
    ].join('\r\n')
    expect(parseVCards(vcf)).toEqual([
      {
        name: 'Dr. Ann Q Lee',
        family: 'Lee',
        given: 'Ann',
        middle: 'Q',
        prefix: 'Dr.',
        org: 'Acme, Research',
        title: 'Chemist',
        phones: [
          { value: '+1 (555) 123-4567', label: 'mobile' },
          { value: '+44 7700 900123', label: 'Boat' },
          { value: '555 000 1111', label: 'home' },
        ],
        emails: [{ value: 'ann@acme.example', label: 'work' }],
        handles: [{ value: 'twitter:annlee' }, { value: 'telegram:ann_l' }],
        addresses: [
          {
            label: 'home',
            street: '1 Main St\nApt 2',
            locality: 'Springfield',
            region: 'IL',
            postcode: '62701',
            country: 'USA',
          },
        ],
        birthday: '--05-01',
        note: 'Met at the, conference\nTwice',
        photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        uid: 'abc-123',
      },
    ])
  })

  it('reads vCard 2.1 from Android: bare types and quoted-printable UTF-8 across lines', () => {
    const vcf = [
      'BEGIN:VCARD',
      'VERSION:2.1',
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=B6rg;;;',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=B6rg M=C3=BC=',
      'ller',
      'TEL;CELL;PREF:+49 30 1234567',
      'TEL;WORK;FAX:030 7654321',
      'END:VCARD',
      'BEGIN:VCARD',
      'VERSION:2.1',
      'END:VCARD',
    ].join('\n')
    expect(parseVCards(vcf)).toEqual([
      {
        name: 'Jörg Müller',
        family: 'Müller',
        given: 'Jörg',
        phones: [
          { value: '+49 30 1234567', label: 'mobile' },
          { value: '030 7654321', label: 'work fax' },
        ],
      },
    ])
  })

  it('reads vCard 4.0 URIs and names a card with no FN from its parts', () => {
    const vcf =
      'BEGIN:VCARD\nVERSION:4.0\nN:Ray;Bob;;;\nTEL;VALUE=uri;TYPE=cell:tel:+15550002222\nEMAIL:mailto:bob@example.com\nEND:VCARD\n'
    expect(parseVCards(vcf)).toEqual([
      {
        name: 'Bob Ray',
        family: 'Ray',
        given: 'Bob',
        phones: [{ value: '+15550002222', label: 'mobile' }],
        emails: [{ value: 'bob@example.com' }],
      },
    ])
  })

  it('writes cards that read back the same', () => {
    const cards = [
      {
        name: 'Ann; Lee, PhD',
        given: 'Ann',
        family: 'Lee',
        phones: [
          { value: '+15551234567', label: 'mobile' },
          { value: '+447700900123', label: 'Boat' },
        ],
        emails: [{ value: 'ann@example.com', label: 'home' }],
        handles: [{ value: 'telegram:ann_l' }],
        urls: [{ value: 'https://ann.example' }],
        addresses: [{ street: '1 Main St', locality: 'Springfield', country: 'USA' }],
        birthday: '1990-05-01',
        note: 'Line one\nLine two — and a very long line that has to be folded because it runs well past seventy-five bytes ✓',
        uid: 'abc-123',
      },
    ]
    const text = toVCards(cards)
    for (const line of text.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    expect(parseVCards(text)).toEqual(cards)
  })
})

describe('CSV', () => {
  it('reads a Google Contacts export', () => {
    const csv = [
      'First Name,Middle Name,Last Name,Organization Name,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,Website 1 - Label,Website 1 - Value',
      'Ann,,Lee,Acme,1990-05-01,"Said ""hi""\nonce",* myContacts,* Home,ann@example.com ::: ann@work.example,Mobile,+1 555 123 4567,,,Profile,https://instagram.com/ann.lee',
      ',,,,,,,,,,,,,,',
    ].join('\n')
    expect(parseContactsCsv(csv)).toEqual([
      {
        name: 'Ann Lee',
        given: 'Ann',
        family: 'Lee',
        org: 'Acme',
        birthday: '1990-05-01',
        note: 'Said "hi"\nonce',
        emails: [
          { value: 'ann@example.com', label: 'home' },
          { value: 'ann@work.example', label: 'home' },
        ],
        phones: [{ value: '+1 555 123 4567', label: 'mobile' }],
        handles: [{ value: 'instagram:ann.lee' }],
      },
    ])
  })

  it('reads a Google address given in parts, and a quoted-printable semicolon as text', () => {
    const csv = [
      'First Name,Address 1 - Label,Address 1 - Street,Address 1 - City,Address 1 - Region,Address 1 - Postal Code,Address 1 - Country',
      'Ann,Home,1 Main St,Springfield,IL,62701,USA',
    ].join('\n')
    expect(parseContactsCsv(csv)[0]!.addresses).toEqual([
      { street: '1 Main St', locality: 'Springfield', region: 'IL', postcode: '62701', country: 'USA', label: 'home' },
    ])
    const vcf =
      'BEGIN:VCARD\nVERSION:2.1\nFN:Ann\nADR;HOME;ENCODING=QUOTED-PRINTABLE:;;Flat 2=3B 1 Main St;Springfield;IL;62701;USA\nEND:VCARD\n'
    expect(parseVCards(vcf)[0]!.addresses).toEqual([
      {
        street: 'Flat 2; 1 Main St',
        locality: 'Springfield',
        region: 'IL',
        postcode: '62701',
        country: 'USA',
        label: 'home',
      },
    ])
  })

  it('reads a Google address with only some of its parts, and an encoded backslash before a semicolon', () => {
    expect(
      parseContactsCsv('First Name,Address 1 - City,Address 1 - Country\nAnn,Springfield,USA')[0]!.addresses,
    ).toEqual([{ locality: 'Springfield', country: 'USA' }])
    const vcf = 'BEGIN:VCARD\nVERSION:2.1\nFN:Ann\nADR;ENCODING=QUOTED-PRINTABLE:;;Test=5C; Suite;City;;;\nEND:VCARD\n'
    expect(parseVCards(vcf)[0]!.addresses).toEqual([{ street: 'Test; Suite', locality: 'City' }])
  })

  it('reads a Shift-JIS character whose second byte is a backslash’s', () => {
    // ソ is 0x83 0x5C in Shift-JIS.
    const vcf = 'BEGIN:VCARD\nVERSION:2.1\nN;CHARSET=SHIFT_JIS;ENCODING=QUOTED-PRINTABLE:=83=5C;Taro;;;\nEND:VCARD\n'
    expect(parseVCards(vcf)[0]).toMatchObject({ family: 'ソ', given: 'Taro' })
  })

  it('keeps a note’s Windows line breaks through a vCard export', () => {
    const [card] = parseContactsCsv('Name,Notes\r\nAnn,"one\r\ntwo\rthree"\r\n')
    expect(parseVCards(toVCards([card!]))[0]!.note).toBe('one\ntwo\nthree')
  })

  it('reads an Outlook export’s postal addresses', () => {
    const csv = [
      'First Name,Home Street,Home Street 2,Home City,Home State,Home Postal Code,Home Country/Region,Business City',
      'Ann,1 Main St,Apt 2,Springfield,IL,62701,USA,Chicago',
    ].join('\r\n')
    expect(parseContactsCsv(csv)[0]!.addresses).toEqual([
      {
        label: 'home',
        street: '1 Main St\nApt 2',
        locality: 'Springfield',
        region: 'IL',
        postcode: '62701',
        country: 'USA',
      },
      { label: 'work', locality: 'Chicago' },
    ])
  })

  it('reads an Outlook export', () => {
    const csv =
      'First Name,Last Name,Company,E-mail Address,E-mail 2 Address,Mobile Phone,Business Phone,Home Fax\r\nBob,Ray,,bob@example.com,,555-0100-222,555-0100-333,\r\n'
    expect(parseContactsFile(csv)).toEqual([
      {
        name: 'Bob Ray',
        given: 'Bob',
        family: 'Ray',
        phones: [
          { value: '555-0100-222', label: 'mobile' },
          { value: '555-0100-333', label: 'work' },
        ],
        emails: [{ value: 'bob@example.com' }],
      },
    ])
  })
})

describe('telling files apart', () => {
  it('reads a CSV whose first note says BEGIN:VCARD as a CSV', () => {
    const csv = ['Name,Notes,Phone 1 - Value', 'Ann,"BEGIN:VCARD pasted here",+15551234567'].join('\n')
    expect(parseContactsFile(csv)).toEqual([
      { name: 'Ann', note: 'BEGIN:VCARD pasted here', phones: [{ value: '+15551234567' }] },
    ])
  })

  it('reads a vCard file after a byte-order mark and blank lines', () => {
    expect(parseContactsFile('\uFEFF\r\n\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann\r\nEND:VCARD\r\n')).toEqual([
      { name: 'Ann' },
    ])
  })
})

describe('large files', () => {
  it('reads every card, past the address book’s limit, so the import can say how many are over', () => {
    const count = MAX_IMPORT_CARDS + 1
    const vcf = Array.from({ length: count }, (_, i) => `BEGIN:VCARD\nFN:P${i}\nEND:VCARD`).join('\n')
    expect(parseVCards(vcf)).toHaveLength(count)
    const csv = ['Name', ...Array.from({ length: count }, (_, i) => `P${i}`)].join('\n')
    expect(parseContactsCsv(csv)).toHaveLength(count)
  })

  it('reads a CSV’s UID column, so importing it again updates the same cards', () => {
    expect(parseContactsCsv('Name,UID\nAnn,abc-1')).toEqual([{ name: 'Ann', uid: 'abc-1' }])
  })
})
