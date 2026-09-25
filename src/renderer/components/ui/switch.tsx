import * as React from 'react'
import { Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * shadcn/ui Switch, styled as the design's toggle (design/designInpo.html): a 32 × 18 pill,
 * white knob, electric blue (the accent's deep tone) when on.
 */
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.JSX.Element {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-300 outline-none',
        'bg-text-primary/15 data-[state=checked]:bg-accent-2',
        'focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:ring-offset-0',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-300 data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
