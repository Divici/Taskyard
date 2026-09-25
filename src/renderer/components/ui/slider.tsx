import * as React from 'react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@renderer/lib/utils'

/**
 * shadcn/ui Slider (one thumb), styled as the design's range input (design/designInpo.html): a
 * 4 px track and a 12 px glowing accent thumb.
 */
function Slider({
  className,
  'aria-label': label,
  'aria-labelledby': labelledBy,
  valueText,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /** Read out instead of the bare number (e.g. "16 px"). */
  valueText?: string
}): React.JSX.Element {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        'relative flex w-full touch-none items-center py-1.5 select-none data-[disabled]:opacity-50',
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="relative h-1 w-full grow overflow-hidden rounded-full bg-text-primary/10"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="absolute h-full bg-gradient-to-r from-accent-2 to-accent-1"
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-valuetext={valueText}
        className="block size-3 cursor-pointer rounded-full bg-accent-1 shadow-[0_0_10px_var(--accent-1)] transition-[box-shadow] outline-none hover:shadow-[0_0_14px_var(--accent-1)] focus-visible:ring-2 focus-visible:ring-text-primary"
      />
    </SliderPrimitive.Root>
  )
}

export { Slider }
