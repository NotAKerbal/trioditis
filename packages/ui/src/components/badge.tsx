import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

const badgeVariants = cva('inline-flex shrink-0 items-center justify-center font-bold', {
  variants: {
    variant: {
      /** Unread count or @ on a chat row. */
      count: 'h-[19px] min-w-[19px] rounded-full bg-primary px-1.5 text-[11px] text-primary-foreground',
      muted: 'h-[19px] min-w-[19px] rounded-full bg-surface-2 px-1.5 text-[11px] text-muted-foreground shadow-[0_0_0_1px_var(--border)]',
      /** Small tags: a network's maturity, "Woke", "Sending". */
      tag: 'rounded-[5px] bg-primary-soft px-1.5 text-[10.5px] leading-4 tracking-wide text-primary-ink',
      outline: 'rounded-[4px] border border-border-strong px-1 text-[9.5px] leading-[14px] font-medium text-subtle-foreground',
    },
  },
  defaultVariants: { variant: 'count' },
})

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
