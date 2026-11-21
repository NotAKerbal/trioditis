import { api } from '@trioditis/backend/api'
import {
  cardFromGoogle,
  GOOGLE_PERSON_FIELDS,
  MAX_IMPORT_CARDS,
  type GoogleConnectionsPage,
  type PersonPlaintext,
} from '@trioditis/core'
import { convexQuery } from '@convex-dev/react-query'
import { useQuery } from '@tanstack/react-query'

// Reading the person's contacts from Google with a token only this page holds
// (lib/google-sign-in.ts). The cards are sealed and saved like an imported file's.

/** The server's Google client ID: null when no admin has set one up, undefined while loading. */
export function useGoogleClientId(): string | null | undefined {
  const { data } = useQuery(convexQuery(api.google.contacts, {}))
  return data === undefined ? undefined : data.clientId
}

/** Google said no, with what to tell the person. */
export class GoogleRefused extends Error {}

const PAGE_SIZE = 1000
/** How many photos are fetched at once. */
const PHOTO_FETCHES = 6

async function googleJson<T>(url: string, token: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store' })
  if (response.ok) return (await response.json()) as T
  if (response.status === 401) throw new GoogleRefused('Google sign-in ran out. Try again.')
  if (response.status === 403) {
    // Most often the People API isn't turned on in the client ID's Google Cloud project.
    throw new GoogleRefused(
      'Google refused to share your contacts. An admin may need to turn on the People API for this server’s Google client.',
    )
  }
  if (response.status === 429) throw new GoogleRefused('Google is busy. Wait a minute, then try again.')
  throw new GoogleRefused(`Google couldn’t send your contacts (${response.status}). Try again.`)
}

/**
 * Every contact in the person's Google account, as cards, with their photos where Google has
 * one of its own (`photo` holds its address, for the import to fetch and make smaller). Stops
 * past what an address book can hold, so the import refuses it with the numbers.
 */
export async function readGoogleContacts(
  token: string,
  { signal, onProgress }: { signal?: AbortSignal; onProgress?: (read: number) => void } = {},
): Promise<PersonPlaintext[]> {
  const cards: PersonPlaintext[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      personFields: GOOGLE_PERSON_FIELDS,
      pageSize: String(PAGE_SIZE),
      sortOrder: 'FIRST_NAME_ASCENDING',
    })
    if (pageToken) params.set('pageToken', pageToken)
    const page = await googleJson<GoogleConnectionsPage>(
      `https://people.googleapis.com/v1/people/me/connections?${params}`,
      token,
      signal,
    )
    for (const person of page.connections ?? []) {
      const made = cardFromGoogle(person)
      if (!made) continue
      cards.push(made.photoUrl ? { ...made.card, photo: made.photoUrl } : made.card)
    }
    onProgress?.(cards.length)
    pageToken = page.nextPageToken || undefined
  } while (pageToken && cards.length <= MAX_IMPORT_CARDS)
  return cards
}

/**
 * Fetches each card's photo from Google as a `data:` URL, a few at once, so the import only has
 * to make it smaller. One that can't be fetched is left out. Answers how many were.
 */
export async function fetchGooglePhotos(cards: PersonPlaintext[], signal?: AbortSignal): Promise<number> {
  const waiting = cards.filter((c) => c.photo?.startsWith('https://'))
  let failed = 0
  const next = async () => {
    for (let card = waiting.shift(); card; card = waiting.shift()) {
      try {
        const response = await fetch(card.photo!, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
        if (!response.ok) throw new Error(String(response.status))
        card.photo = await dataUrl(await response.blob())
      } catch {
        if (signal?.aborted) throw signal.reason
        delete card.photo
        failed++
      }
    }
  }
  await Promise.all(Array.from({ length: PHOTO_FETCHES }, next))
  return failed
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}
