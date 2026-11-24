// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import data from 'emojibase-data/en/data.json'
import messages from 'emojibase-data/en/messages.json'
import {
  MAX_EMOJI_VERSION,
  noteReaction,
  QUICK_REACTIONS,
  quickReactions,
  recentReactions,
  resolveEmojiData,
  toEmojiData,
} from '../src/data/emoji.ts'

afterEach(() => localStorage.clear())

describe('the reaction picker’s emoji', () => {
  it('come from the app’s own copy, in groups, without skin-tone pieces or emoji too new to draw', async () => {
    const loaded = await resolveEmojiData()
    expect(loaded.locale).toBe('en')
    expect(loaded.categories.map((c) => c.label)).toContain('Smileys & emotion')
    expect(loaded.categories.map((c) => c.label)).not.toContain('Components')
    expect(loaded.emojis.length).toBeGreaterThan(1500)
    expect(loaded.emojis.every((e) => e.version <= MAX_EMOJI_VERSION)).toBe(true)
    expect(loaded.emojis.some((e) => e.category === 2)).toBe(false)
    // Every emoji's group is one of the categories.
    const groups = new Set(loaded.categories.map((c) => c.index))
    expect(loaded.emojis.every((e) => groups.has(e.category))).toBe(true)
  })

  it('have their skin tones by name, and flags marked', () => {
    const built = toEmojiData(data as never, messages as never)
    const wave = built.emojis.find((e) => e.emoji === '👋')!
    expect(wave).toMatchObject({ label: 'Waving hand', tags: expect.arrayContaining(['hello']) })
    expect(wave.skins).toEqual({ light: '👋🏻', 'medium-light': '👋🏼', medium: '👋🏽', 'medium-dark': '👋🏾', dark: '👋🏿' })
    expect(built.skinTones.light).toBe('Light skin tone')
    expect(built.emojis.find((e) => e.emoji === '🇫🇷')?.countryFlag).toBe(true)
    expect(built.emojis.find((e) => e.emoji === '😀')?.countryFlag).toBeUndefined()
    // A lower limit leaves newer emoji out.
    expect(toEmojiData(data as never, messages as never, 1).emojis.every((e) => e.version <= 1)).toBe(true)
  })
})

describe('the quick row', () => {
  it('starts with the usual reactions', () => {
    expect(quickReactions(recentReactions())).toEqual([...QUICK_REACTIONS])
  })

  it('puts the person’s latest picks first, once each, keeping its length', () => {
    noteReaction('🔥')
    noteReaction('👍')
    noteReaction('❤')
    expect(recentReactions()).toEqual(['❤', '👍', '🔥'])
    const row = quickReactions(recentReactions())
    expect(row).toEqual(['❤', '👍', '🔥', '😂', '😮', '😢'])
  })

  it('works without storage', () => {
    localStorage.setItem('trioditis.recentReactions', 'not json')
    expect(recentReactions()).toEqual([])
  })
})
