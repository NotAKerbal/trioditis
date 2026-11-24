import { Button } from '@trioditis/ui/button'
import { cn } from '@trioditis/ui/lib/utils'
import { ChevronRight } from 'lucide-react'
import { Children, type ReactNode } from 'react'

/** A settings section's title, for assistive tech: the selected section in the nav already shows it. */
export function Heading({ title }: { title: string }) {
  return <h2 className="sr-only">{title}</h2>
}

/**
 * A part of a section: a small heading, an action beside it if there is one, then its rows in one
 * box. The box is left out when there are no rows, so a heading and its action can stand alone.
 */
export function Group({ title, action, children }: { title?: string; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="mt-7 first-of-type:mt-0">
      {title || action ? (
        <div className="mb-2 flex min-h-8 items-center gap-2 px-1">
          <h3 className="flex-1 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">{title}</h3>
          {action}
        </div>
      ) : null}
      {Children.toArray(children).length ? (
        <div className="divide-y divide-border rounded-xl shadow-[0_0_0_1px_var(--border)]">{children}</div>
      ) : null}
    </section>
  )
}

/** A row that opens and closes the rows after it, for a list people browse only now and then. */
export function Disclosure({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Button
      variant="bare"
      type="button"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      className="flex min-h-[52px] w-full items-center gap-2.5 px-4 py-3 text-left font-semibold first:rounded-t-xl last:rounded-b-xl hover:bg-surface-2"
    >
      <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      {children}
    </Button>
  )
}

/** What an empty pane shows while its data is on the way, or once it has failed to come. */
export function Loading({ failed }: { failed?: boolean }) {
  return failed ? (
    <p role="alert" className="py-2 text-sm text-muted-foreground">
      This couldn’t be loaded. Reload the page to try again.
    </p>
  ) : (
    <p className="py-2 text-sm text-muted-foreground" aria-busy="true">
      Loading…
    </p>
  )
}

/**
 * One row of a group: what it is on the left, its control on the right, and anything it opens
 * (a form, a reveal) below. On a narrow screen a wide control moves under the title rather than
 * squeezing it.
 */
export function Setting({
  title,
  about,
  children,
  below,
}: {
  title: string
  about?: ReactNode
  children?: ReactNode
  below?: ReactNode
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex min-h-9 flex-wrap items-center gap-x-[18px] gap-y-2">
        <div className="min-w-0 flex-[1_1_10rem]">
          <div className="font-semibold">{title}</div>
          {about ? <div className="mt-0.5 text-sm text-muted-foreground">{about}</div> : null}
        </div>
        {children}
      </div>
      {below ? <div className="mt-3">{below}</div> : null}
    </div>
  )
}
