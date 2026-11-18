import { DropdownMenu as Primitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

const DropdownMenu = Primitive.Root
const DropdownMenuTrigger = Primitive.Trigger
const DropdownMenuGroup = Primitive.Group
const DropdownMenuRadioGroup = Primitive.RadioGroup

function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          'z-50 min-w-[240px] rounded-lg bg-popover p-1.5 text-popover-foreground shadow-popover ring-1 ring-border outline-none',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  )
}

const itemClass =
  'relative flex h-[34px] cursor-default items-center gap-2.5 rounded-md px-2.5 text-base outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="dropdown-menu-item" className={cn(itemClass, className)} {...props} />
}

/** An item that is on or off; shows the current choice. */
function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof Primitive.CheckboxItem>) {
  return (
    <Primitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        itemClass,
        'data-[state=checked]:bg-primary-soft data-[state=checked]:font-semibold data-[state=checked]:text-primary-ink',
        className,
      )}
      {...props}
    >
      {children}
    </Primitive.CheckboxItem>
  )
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label
      className={cn(
        'px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-subtle-foreground uppercase',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator className={cn('mx-1 my-1.5 h-px bg-border', className)} {...props} />
}

/** Right-aligned extra text in an item: a count, a time, a shortcut. */
function DropdownMenuTrail({ className, ...props }: React.ComponentProps<'span'>) {
  return <span className={cn('ml-auto text-sm text-subtle-foreground tabular-nums', className)} {...props} />
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrail,
}
