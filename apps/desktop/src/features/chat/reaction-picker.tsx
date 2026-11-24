import { Button } from '@trioditis/ui/button'
import { InputGroup } from '@trioditis/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@trioditis/ui/popover'
import { cn } from '@trioditis/ui/lib/utils'
import {
  EmojiPicker,
  type EmojiPickerListCategoryHeaderProps,
  type EmojiPickerListEmojiProps,
  type EmojiPickerListRowProps,
  type SkinTone,
} from 'frimousse'
import { Plus, Search, SmilePlus } from 'lucide-react'
import { createContext, useContext, useState, type KeyboardEvent } from 'react'
import { noteReaction, quickReactions, recentReactions, resolveEmojiData } from '~/data/emoji.ts'
import { sameKey, shownKey } from '~/data/reaction-toggle.ts'

/**
 * Picks a reaction: a row of the person's latest and the usual ones, and every emoji, searchable,
 * behind its +. One the person has given already is marked, and picking it takes it away.
 */
export function ReactionPicker({
  mine,
  onPick,
  triggerClassName,
}: {
  mine: readonly string[]
  onPick: (key: string) => void
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const pick = (key: string) => {
    noteReaction(key)
    setOpen(false)
    onPick(key)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Each opening starts from the row, with what was picked last on any message.
        if (next) {
          setFull(false)
          setRecent(recentReactions())
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="bare"
          type="button"
          aria-label="React"
          title="React"
          className={cn(triggerClassName, 'data-[state=open]:text-foreground data-[state=open]:opacity-100')}
        >
          <SmilePlus className="size-[15px]" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className={full ? 'overflow-hidden p-0' : 'p-1'}>
        {full ? (
          <AllEmoji mine={mine} onPick={pick} />
        ) : (
          <div role="group" aria-label="Reactions" className="flex gap-0.5" onKeyDown={arrowsAcross}>
            {quickReactions(recent).map((key) => (
              <Button
                variant="bare"
                type="button"
                key={key}
                aria-pressed={mine.some((k) => sameKey(k, key))}
                onClick={() => pick(key)}
                className="size-9 rounded-md text-xl hover:bg-surface-2 aria-pressed:bg-primary-soft"
              >
                {shownKey(key)}
              </Button>
            ))}
            <Button
              variant="bare"
              type="button"
              aria-label="More reactions"
              title="More reactions"
              onClick={() => setFull(true)}
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <Plus className="size-[18px]" />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Left and right arrows move along the row, as in a menu. */
function arrowsAcross(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('button')]
  const at = buttons.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  e.preventDefault()
  buttons[(at + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
}

const TONE_KEY = 'trioditis.skinTone'
const TONES: SkinTone[] = ['none', 'light', 'medium-light', 'medium', 'medium-dark', 'dark']

function savedTone(): SkinTone {
  try {
    const saved = localStorage.getItem(TONE_KEY)
    return TONES.find((t) => t === saved) ?? 'none'
  } catch {
    return 'none'
  }
}

function saveTone(tone: SkinTone) {
  try {
    localStorage.setItem(TONE_KEY, tone)
  } catch {
    // Not kept past this picker.
  }
}

/** The person's own reactions on the message, for the grid to mark. */
const Mine = createContext<readonly string[]>([])

/** Every emoji, searchable, in groups. */
function AllEmoji({ mine, onPick }: { mine: readonly string[]; onPick: (key: string) => void }) {
  return (
    <Mine.Provider value={mine}>
      <EmojiPicker.Root
        resolveEmojiData={resolveEmojiData}
        skinTone={savedTone()}
        columns={9}
        onEmojiSelect={({ emoji }) => onPick(emoji)}
        className="isolate flex h-[360px] w-fit flex-col"
      >
        <div className="flex items-center gap-1 p-2">
          <InputGroup icon={<Search className="size-4 shrink-0" />} className="min-w-0 flex-1">
            <EmojiPicker.Search autoFocus placeholder="Search" aria-label="Search emoji" />
          </InputGroup>
          <EmojiPicker.SkinTone emoji="👋">
            {({ skinTone, setSkinTone, skinToneVariations }) => {
              const at = Math.max(
                0,
                skinToneVariations.findIndex((v) => v.skinTone === skinTone),
              )
              const next = skinToneVariations[(at + 1) % skinToneVariations.length]!
              return (
                <Button
                  variant="ghost"
                  size="icon"
                  type="button"
                  aria-label="Change skin tone"
                  title="Change skin tone"
                  className="text-lg"
                  onClick={() => {
                    setSkinTone(next.skinTone)
                    saveTone(next.skinTone)
                  }}
                >
                  {skinToneVariations[at]?.emoji}
                </Button>
              )
            }}
          </EmojiPicker.SkinTone>
        </div>
        <EmojiPicker.Viewport className="relative flex-1 outline-none">
          <EmojiPicker.Loading className="absolute inset-0 flex items-center justify-center text-sm text-subtle-foreground">
            Loading…
          </EmojiPicker.Loading>
          <EmojiPicker.Empty className="absolute inset-0 flex items-center justify-center text-sm text-subtle-foreground">
            No emoji found
          </EmojiPicker.Empty>
          <EmojiPicker.List className="pb-1.5 select-none" components={{ CategoryHeader, Row, Emoji }} />
        </EmojiPicker.Viewport>
      </EmojiPicker.Root>
    </Mine.Provider>
  )
}

function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div {...props} className="bg-popover px-3 pt-3 pb-1.5 text-xs font-medium text-subtle-foreground">
      {category.label}
    </div>
  )
}

function Row(props: EmojiPickerListRowProps) {
  return <div {...props} className="scroll-my-1.5 px-1.5" />
}

function Emoji({ emoji, ...props }: EmojiPickerListEmojiProps) {
  const mine = useContext(Mine).some((k) => sameKey(k, emoji.emoji))
  return (
    <Button
      variant="bare"
      {...props}
      aria-pressed={mine}
      className={cn(
        'flex size-8 items-center justify-center rounded-md text-xl',
        emoji.isActive && 'bg-surface-2',
        mine && 'bg-primary-soft',
      )}
    >
      {emoji.emoji}
    </Button>
  )
}
