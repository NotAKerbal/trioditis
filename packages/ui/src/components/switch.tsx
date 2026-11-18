import { Switch as Primitive } from 'radix-ui'
import type * as React from 'react'
import { cn } from '../lib/utils.ts'

function Switch({ className, ...props }: React.ComponentProps<typeof Primitive.Root>) {
  return (
    <Primitive.Root
      data-slot="switch"
      className={cn('relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer rounded-full bg-border-strong transition-colors duration-(--duration-fast) data-[state=checked]:bg-primary disabled:opacity-50', className)}
      {...props}
    >
      <Primitive.Thumb className="block size-4 translate-x-[3px] translate-y-[3px] rounded-full bg-white shadow-raised transition-transform duration-(--duration-fast) data-[state=checked]:translate-x-[19px]" />
    </Primitive.Root>
  )
}

export { Switch }
