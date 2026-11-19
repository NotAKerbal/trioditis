import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

const textareaVariants = cva(
  'w-full min-w-0 text-base text-foreground outline-none placeholder:text-subtle-foreground',
  {
    variants: {
      variant: {
        // A form field, framed like Input.
        field:
          'min-h-20 rounded-md border border-input bg-surface px-3 py-2 transition-shadow focus-visible:border-ring focus-visible:shadow-[0_0_0_3px_var(--accent-soft)] disabled:opacity-50 aria-invalid:border-danger',
        // No frame, for a text area inside something that draws its own, like the composer.
        bare: 'resize-none bg-transparent',
      },
    },
    defaultVariants: { variant: 'field' },
  },
)

function Textarea({
  className,
  variant,
  ...props
}: React.ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>) {
  return <textarea data-slot="textarea" className={cn(textareaVariants({ variant }), className)} {...props} />
}

export { Textarea, textareaVariants }
