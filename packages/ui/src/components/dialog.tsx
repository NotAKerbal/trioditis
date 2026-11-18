import { Dialog as Primitive } from 'radix-ui'
import { X } from 'lucide-react'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

// Radix makes the rest of the page inert while a dialog is open, traps focus inside it and
// returns focus to the opener on close.
const Dialog = Primitive.Root
const DialogTrigger = Primitive.Trigger
const DialogClose = Primitive.Close

function DialogContent({
  className,
  children,
  closeLabel = 'Close',
  ...props
}: React.ComponentProps<typeof Primitive.Content> & { closeLabel?: string }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-scrim" />
      <Primitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-surface text-foreground shadow-dialog outline-none',
          className,
        )}
        {...props}
      >
        {children}
        <Primitive.Close
          aria-label={closeLabel}
          className="absolute top-4 right-4 inline-flex size-(--control-md) items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-[18px]" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof Primitive.Title>) {
  return <Primitive.Title className={cn('text-lg font-bold tracking-[-0.015em]', className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof Primitive.Description>) {
  return <Primitive.Description className={cn('text-base text-muted-foreground', className)} {...props} />
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription }
