import { Check } from 'lucide-react'
import { Checkbox as Primitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

/** A tick box, for agreeing to one thing: "I've saved my recovery key". Put it in a label. */
function Checkbox({ className, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="checkbox"
      className={cn(
        'inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-input bg-surface text-primary-foreground transition-colors duration-(--duration-fast) data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    >
      <Primitive.Indicator className="flex items-center justify-center">
        <Check className="size-3" strokeWidth={3.5} />
      </Primitive.Indicator>
    </Primitive.Root>
  )
}

export { Checkbox }
