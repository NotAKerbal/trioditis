import type { EmojiData } from 'frimousse'
import { sameKey } from './reaction-toggle.ts'

// The reaction picker's emoji come with the app (emojibase-data, loaded the first time the full
// picker opens), never from a CDN: the picker's own loader would fetch them from jsDelivr, telling
// it whenever someone here reacts.

/**
 * The newest Emoji version offered. Current systems draw up to it (macOS 14, Windows 11, Noto
 * Color Emoji on Ubuntu 24.04); newer ones could show as empty boxes, as a reaction no one sees.
 */
export const MAX_EMOJI_VERSION = 15

const TONES = ['light', 'medium-light', 'medium', 'medium-dark', 'dark'] as const

/** The fields of emojibase's `data.json` used here. */
interface RawEmoji {
  emoji: string
  label: string
  group?: number
  subgroup?: number
  version: number
  tags?: string[]
  skins?: { emoji: string; tone?: number | number[] }[]
}
interface RawMessages {
  groups: { key: string; message: string; order: number }[]
  subgroups: { key: string; message: string; order: number }[]
  skinTones: { key: string; message: string }[]
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Emojibase's data as the picker takes it, as its own loader would make it. */
export function toEmojiData(
  raw: readonly RawEmoji[],
  messages: RawMessages,
  maxVersion = MAX_EMOJI_VERSION,
): EmojiData {
  const flags = new Set(
    messages.subgroups.filter((s) => s.key === 'country-flag' || s.key === 'subdivision-flag').map((s) => s.order),
  )
  const skinTones = Object.fromEntries(
    messages.skinTones.map((t) => [t.key, capitalize(t.message)]),
  ) as EmojiData['skinTones']
  return {
    locale: 'en',
    // Skin-tone pieces ("component") aren't emoji to send on their own.
    categories: messages.groups
      .filter((g) => g.key !== 'component')
      .map((g) => ({ index: g.order, label: capitalize(g.message) })),
    skinTones,
    emojis: raw.flatMap((e) => {
      if (e.group === undefined || e.group === 2 || e.version > maxVersion) return []
      // One tone per skin; a pair's two tones (people holding hands) aren't offered on their own.
      const skins = e.skins?.filter((s) => typeof s.tone === 'number')
      return [
        {
          emoji: e.emoji,
          category: e.group,
          label: capitalize(e.label),
          version: e.version,
          tags: e.tags ?? [],
          ...(e.subgroup !== undefined && flags.has(e.subgroup) ? { countryFlag: true as const } : {}),
          ...(skins?.length === TONES.length
            ? {
                skins: Object.fromEntries(
                  skins.map((s) => [TONES[(s.tone as number) - 1], s.emoji]),
                ) as EmojiData['skinTones'],
              }
            : {}),
        },
      ]
    }),
  }
}

let loading: Promise<EmojiData> | null = null

/** The picker's emoji, loaded once; a load that failed is tried again next time. */
export function resolveEmojiData(): Promise<EmojiData> {
  loading ??= Promise.all([import('emojibase-data/en/data.json'), import('emojibase-data/en/messages.json')]).then(
    ([data, messages]) =>
      toEmojiData(data.default as unknown as RawEmoji[], messages.default as unknown as RawMessages),
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** The reactions offered first, before the person has picked others. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const

const RECENT_KEY = 'trioditis.recentReactions'
const RECENT_KEPT = 12

/** The reactions this device picked last, newest first. Empty when storage can't be read. */
export function recentReactions(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(saved) ? saved.filter((k): k is string => typeof k === 'string').slice(0, RECENT_KEPT) : []
  } catch {
    return []
  }
}

/** Notes a reaction the person picked, for the quick row next time. */
export function noteReaction(key: string) {
  const list = [key, ...recentReactions().filter((k) => !sameKey(k, key))].slice(0, RECENT_KEPT)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    // Not kept: the quick row stays as it was.
  }
}

/** The quick row: the person's latest picks first, then the usual ones, `count` in all. */
export function quickReactions(recent: readonly string[], count = QUICK_REACTIONS.length): string[] {
  const out: string[] = []
  for (const key of [...recent, ...QUICK_REACTIONS]) {
    if (out.length === count) break
    if (!out.some((k) => sameKey(k, key))) out.push(key)
  }
  return out
}
