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
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className={cn('size-full object-cover', shape === 'circle' ? 'rounded-full' : 'rounded-[30%]')}
        />
      ) : (
        initials(name)
      )}
      {badge ? (
        <span className="absolute -right-[3px] -bottom-[3px] rounded-[5px] ring-2 ring-[var(--avatar-ring,var(--rail))]">
          {badge}
        </span>
      ) : null}
    </span>
  )
}

export { Avatar }
