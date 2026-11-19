import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/** A keyboard key, for shortcut hints. */
function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'rounded-[4px] border border-border-strong px-1.5 py-0.5 font-sans text-[10.5px] leading-none font-medium text-subtle-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Kbd }
