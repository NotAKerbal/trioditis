import { ToggleGroup as Primitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/** Pick one of a few options, side by side: "Everything / Mentions / Off". */
type SegmentedProps = {
  value: string
  onValueChange: (value: string) => void
  children: React.ReactNode
  className?: string
  'aria-label'?: string
}

function Segmented({ className, value, onValueChange, children, 'aria-label': ariaLabel }: SegmentedProps) {
  return (
    <Primitive.Root
      type="single"
      value={value}
      // A segmented control always has a choice; ignore clicks that would clear it.
      onValueChange={(next: string) => next && onValueChange(next)}
      aria-label={ariaLabel}
      className={cn('flex rounded-md bg-surface-2 p-[3px] shadow-[inset_0_0_0_1px_var(--border)]', className)}
    >
      {children}
    </Primitive.Root>
  )
}

function SegmentedItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'h-7 flex-1 cursor-pointer rounded-[7px] text-sm font-medium text-muted-foreground data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-[var(--elevation-sm),0_0_0_1px_var(--border)]',
        className,
      )}
      {...props}
    />
  )
}

export { Segmented, SegmentedItem }
