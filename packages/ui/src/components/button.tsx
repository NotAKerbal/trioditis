import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-semibold whitespace-nowrap transition-colors duration-(--duration-fast) ease-(--ease-out) select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        secondary: 'bg-surface text-foreground shadow-[0_0_0_1px_var(--border-strong)] hover:bg-surface-2',
        ghost: 'text-muted-foreground hover:bg-rail-hover hover:text-foreground',
        link: 'h-auto px-0 text-primary hover:underline',
        danger: 'text-danger shadow-[0_0_0_1px_color-mix(in_srgb,var(--danger)_45%,transparent)] hover:bg-danger/10',
      },
      size: {
        sm: 'h-(--control-sm) rounded-sm px-2.5 text-sm',
        md: 'h-(--control-md) rounded-md px-3.5 text-sm',
        lg: 'h-(--control-lg) rounded-md px-4 text-base',
        icon: 'size-(--control-md) rounded-md',
        'icon-sm': 'size-(--control-sm) rounded-sm',
      },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element (a link, say) with the button's styles. */
    asChild?: boolean
    /** Shows a spinner and blocks clicks while an action runs. */
    loading?: boolean
  }

function Button({ className, variant, size, block, asChild = false, loading = false, disabled, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, block }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
      ) : null}
      {children}
    </Comp>
  )
}

export { Button, buttonVariants, type ButtonProps }
