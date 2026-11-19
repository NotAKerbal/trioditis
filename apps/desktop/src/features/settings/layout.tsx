import { DialogDescription } from '@trioditis/ui/dialog'
import { cn } from '@trioditis/ui/lib/utils'
import type { ReactNode } from 'react'

/** A settings section's title, and the line under it that the dialog is described by. */
export function Heading({ title, lead }: { title: string; lead: string }) {
  return (
    <>
      <h2 className="pr-10 text-lg font-bold tracking-[-0.015em]">{title}</h2>
      <DialogDescription className="mt-1 mb-3.5">{lead}</DialogDescription>
    </>
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
  about: string
  children: ReactNode
  column?: boolean
}) {
  return (
    <div className={cn('border-t border-border py-[15px]', column ? 'block' : 'flex items-center gap-[18px]')}>
      <div className="min-w-0 flex-1">
        <b className="block font-semibold">{title}</b>
        <span className="mt-0.5 block text-sm text-muted-foreground">{about}</span>
      </div>
      {children}
    </div>
  )
}
