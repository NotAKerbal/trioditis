import type * as React from 'react'
import { cn } from '../lib/utils.ts'

function initials(name: string) {
  const words = name
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .split(/\s+/)
  if (!words[0]) return '#'
  return (words[0][0]! + (words[1]?.[0] ?? '')).toUpperCase()
}

// A stable colour per name, from the label tokens, so the same person keeps the same colour everywhere.
const COLORS = [
  'bg-label-pink',
  'bg-label-blue',
  'bg-label-green',
  'bg-label-amber',
  'bg-label-violet',
  'bg-label-slate',
] as const
function colorFor(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.codePointAt(0)!) % 9973
  return COLORS[h % COLORS.length]
}

type AvatarProps = {
  name: string
  /** An object URL of the decrypted picture, when there is one. */
  src?: string | undefined
  size?: number
  /** Groups get rounded squares, people circles. */
  shape?: 'circle' | 'square'
  /** Drawn at the bottom right, usually a NetworkBadge. */
  badge?: React.ReactNode
  className?: string
}

function Avatar({ name, src, size = 40, shape = 'circle', badge, className }: AvatarProps) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center font-semibold text-on-color',
        shape === 'circle' ? 'rounded-full' : 'rounded-[30%]',
        !src && colorFor(name),
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * (badge ? 0.33 : 0.38)) }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className={cn('size-full object-cover', shape === 'circle' ? 'rounded-full' : 'rounded-[30%]')}
        />
      ) : badge ? (
        // The badge takes the bottom right corner, so the initials sit a little smaller and up and
        // to the left of centre, clear of its ring.
        <span style={{ translate: `${-size * 0.04}px ${-size * 0.04}px` }}>{initials(name)}</span>
      ) : (
        initials(name)
      )}
      {badge ? (
        <span className="absolute -right-[4px] -bottom-[4px] rounded-[5px] ring-2 ring-[var(--avatar-ring,var(--rail))]">
          {badge}
        </span>
      ) : null}
    </span>
  )
}

/**
 * One member's place in an AvatarCollage: their picture, or their initials on their colour. It
 * fills the cell the collage gives it.
 */
function AvatarTile({
  name,
  src,
  size,
  alone = false,
}: {
  name: string
  src?: string | undefined
  size: number
  /** The only tile, filling the whole collage. */
  alone?: boolean
}) {
  return (
    <span
      data-slot="avatar-tile"
      className={cn(
        'flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden',
        !src && colorFor(name),
      )}
      style={{ fontSize: Math.max(8, Math.round(size * (alone ? 0.38 : 0.2))) }}
    >
      {src ? <img src={src} alt="" className="size-full object-cover" /> : initials(name)}
    </span>
  )
}

/**
 * A group's picture made of its members' (one to four AvatarTiles): one alone, two side by side,
 * one beside a stack of two for three, a square of four for four. It has the shape of a group's
 * Avatar, and its badge.
 */
function AvatarCollage({
  size = 40,
  badge,
  className,
  children,
}: {
  size?: number
  badge?: React.ReactNode
  className?: string
  children: React.ReactNode[]
}) {
  const count = Math.min(children.length, 4)
  return (
    <span
      data-slot="avatar"
      className={cn('relative inline-flex shrink-0 font-semibold text-on-color', className)}
      style={{ width: size, height: size }}
    >
      <span
        className={cn(
          // The gaps between tiles are the background the avatar sits on.
          'grid size-full gap-px overflow-hidden rounded-[30%] bg-[var(--avatar-ring,var(--rail))]',
          count > 1 ? 'grid-cols-2' : 'grid-cols-1',
          count > 2 && 'grid-rows-2',
          count === 3 && '[&>*:first-child]:row-span-2',
        )}
      >
        {children.slice(0, count)}
      </span>
      {badge ? (
        <span className="absolute -right-[4px] -bottom-[4px] rounded-[5px] ring-2 ring-[var(--avatar-ring,var(--rail))]">
          {badge}
        </span>
      ) : null}
    </span>
  )
}

export { Avatar, AvatarCollage, AvatarTile }
