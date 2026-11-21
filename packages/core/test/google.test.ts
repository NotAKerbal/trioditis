import { describe, expect, it } from 'vitest'
import { cardFromGoogle, googleClientIdProblem, googleSignInUrl } from '../src/index.ts'

describe('Google Contacts', () => {
  it('makes a card from everything a contact has, primary values first', () => {
    const made = cardFromGoogle({
      resourceName: 'people/c123',
      names: [{ displayName: 'Dr. Ann Lee', givenName: 'Ann', familyName: 'Lee', honorificPrefix: 'Dr.' }],
      nicknames: [{ value: 'Annie' }],
      organizations: [{ name: 'Acme', title: 'Chemist' }],
      phoneNumbers: [
        { value: '555 000 1111', type: 'home' },
        { value: '+1 (555) 123-4567', type: 'mobile', metadata: { primary: true } },
        { value: '+1 555 123 4567', type: 'mobile' },
        { value: '555 222 3333', type: 'Boat' },
      ],
      emailAddresses: [{ value: 'ann@acme.example', type: 'work' }, { value: 'ANN@acme.example' }],
      urls: [{ value: 'https://ann.example', type: 'homePage' }],
      addresses: [
        { type: 'home', streetAddress: '1 Main St', city: 'Springfield', postalCode: '12345', country: 'US' },
      ],
      birthdays: [{ date: { month: 3, day: 9 } }],
      biographies: [{ value: 'Met at the conference.' }],
      photos: [{ url: 'https://lh3.googleusercontent.com/a/photo=s100' }],
    })
    expect(made).toEqual({
      photoUrl: 'https://lh3.googleusercontent.com/a/photo=s100',
      card: {
        name: 'Dr. Ann Lee',
        given: 'Ann',
        family: 'Lee',
        prefix: 'Dr.',
        nickname: 'Annie',
        org: 'Acme',
        title: 'Chemist',
        phones: [
          { value: '+1 (555) 123-4567', label: 'mobile' },
          { value: '555 000 1111', label: 'home' },
          { value: '555 222 3333', label: 'boat' },
        ],
        emails: [{ value: 'ann@acme.example', label: 'work' }],
        urls: [{ value: 'https://ann.example', label: 'homepage' }],
        addresses: [{ label: 'home', street: '1 Main St', locality: 'Springfield', postcode: '12345', country: 'US' }],
        birthday: '--03-09',
        note: 'Met at the conference.',
        uid: 'google:people/c123',
      },
    })
  })

  it('names a contact without a name by what it has, and skips one with nothing', () => {
    expect(cardFromGoogle({ emailAddresses: [{ value: 'bo@example.com' }] })?.card.name).toBe('bo@example.com')
    expect(cardFromGoogle({ organizations: [{ name: 'Acme' }] })?.card.name).toBe('Acme')
    expect(cardFromGoogle({ names: [{ givenName: 'Bo', familyName: 'Ng' }] })?.card.name).toBe('Bo Ng')
    expect(cardFromGoogle({ resourceName: 'people/c1' })).toBeNull()
  })

  it('leaves out Google’s placeholder picture, and keeps a full birthday', () => {
    const made = cardFromGoogle({
      names: [{ displayName: 'Cy' }],
      photos: [{ url: 'https://lh3.googleusercontent.com/default', default: true }],
      birthdays: [{ date: { year: 1990, month: 12, day: 1 } }],
    })
    expect(made?.photoUrl).toBeUndefined()
    expect(made?.card.birthday).toBe('1990-12-01')
  })

  it('checks a client ID', () => {
    expect(googleClientIdProblem('123456789012-abcdefghij0123456789abcdefghij01.apps.googleusercontent.com')).toBeNull()
    expect(googleClientIdProblem('')).not.toBeNull()
    expect(googleClientIdProblem('GOCSPX-secret')).not.toBeNull()
    expect(googleClientIdProblem('123-abc.apps.googleusercontent.com.evil.example')).not.toBeNull()
  })

  it('asks Google for read-only contacts, with the token in the fragment', () => {
    const url = new URL(
      googleSignInUrl({
        clientId: 'id.apps.googleusercontent.com',
        redirectUri: 'https://t.example/google-contacts.html',
        state: 'wabc',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('response_type')).toBe('token')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/contacts.readonly')
    expect(url.searchParams.get('state')).toBe('wabc')
    expect(url.searchParams.get('redirect_uri')).toBe('https://t.example/google-contacts.html')
  })
})
