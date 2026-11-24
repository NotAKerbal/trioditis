import { Popover as Primitive } from 'radix-ui'
import type * as React from 'react'
import { imeEscape } from '../lib/ime.ts'
import { cn } from '../lib/utils.ts'

// A panel anchored to its trigger, for content a menu can't hold (a search field, a grid). Radix
// moves focus into it, closes it on Escape or a click outside, and returns focus to the trigger.
const Popover = Primitive.Root
const PopoverTrigger = Primitive.Trigger
const PopoverAnchor = Primitive.Anchor
const PopoverClose = Primitive.Close

function PopoverContent({
  className,
  sideOffset = 6,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="popover-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 rounded-lg bg-popover text-popover-foreground shadow-popover ring-1 ring-border outline-none',
          className,
        )}
        onEscapeKeyDown={(e) => {
          if (imeEscape(e)) e.preventDefault()
          else onEscapeKeyDown?.(e)
        }}
        {...props}
      />
    </Primitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent }
