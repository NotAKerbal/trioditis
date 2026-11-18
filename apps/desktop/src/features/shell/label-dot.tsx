import { cn } from '@trioditis/ui/lib/utils'
import type { LabelColor } from '~/lib/sealed.ts'

const DOT: Record<LabelColor, string> = {
  pink: 'bg-label-pink',
  blue: 'bg-label-blue',
  green: 'bg-label-green',
  amber: 'bg-label-amber',
  violet: 'bg-label-violet',
  slate: 'bg-label-slate',
}

export function LabelDot({ color, className }: { color: LabelColor; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[color] ?? DOT.slate, className)} />
  )
}
