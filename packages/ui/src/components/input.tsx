import type * as React from 'react'
import { cn } from '../lib/utils.ts'

function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(
        'h-(--control-md) w-full min-w-0 rounded-md border border-input bg-surface px-3 text-base text-foreground transition-shadow outline-none placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A text field with a leading icon and an optional trailing hint, like the sidebar's search. Put
 * an Input in it: the group draws the frame and the focus ring, so the Input's own are taken off.
 */
function InputGroup({
  className,
  icon,
  end,
  children,
}: {
  className?: string
  icon?: React.ReactNode
  end?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <label
      data-slot="input-group"
      className={cn(
        'flex h-(--control-md) min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-subtle-foreground transition-shadow focus-within:border-ring focus-within:shadow-[0_0_0_3px_var(--accent-soft)] [&_input]:h-full [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:rounded-none [&_input]:p-0 [&_input]:text-foreground [&_input]:shadow-none [&_input]:outline-none [&_input]:focus-visible:shadow-none',
        className,
      )}
    >
      {icon}
      {children}
      {end}
    </label>
  )
}

export { Input, InputGroup }
