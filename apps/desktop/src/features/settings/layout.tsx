import { cn } from '@trioditis/ui/lib/utils'
import type { ReactNode } from 'react'

/** A settings section's title, for assistive tech: the selected section in the nav already shows it. */
export function Heading({ title }: { title: string }) {
  return <h2 className="sr-only">{title}</h2>
}

/** A small heading over a group of rows within a section. */
export function Subheading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn('mt-6 mb-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase', className)}>
      {children}
    </h3>
  )
}

/** One setting: what it is on the left, its control on the right (or below, with `column`). */
export function Setting({
  title,
  about,
  children,
  column,
}: {
  title: string
  about?: ReactNode
  children: ReactNode
  column?: boolean
}) {
  return (
    <div className={cn('py-3', column ? 'block' : 'flex min-h-[52px] items-center gap-[18px]')}>
      <div className="min-w-0 flex-1">
        <b className="block font-semibold">{title}</b>
        {about ? <span className="mt-0.5 block text-sm text-muted-foreground">{about}</span> : null}
      </div>
      {children}
    </div>
  )
}
