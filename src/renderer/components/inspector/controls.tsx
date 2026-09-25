import { useId, type ReactNode } from 'react'
import { RadioGroup } from 'radix-ui'
import { cn } from '../../lib/utils'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'

// The inspector's building blocks, styled after design/designInpo.html: section titles with a
// glowing accent dot, 11–12 px labels with the value on the right, the 32 × 18 toggle, the 4 px
// slider and a segmented radio group.

export function InspectorSection({
  title,
  children
}: {
  title: string
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3
        id={id}
        className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-text-primary before:size-1 before:shrink-0 before:rounded-full before:bg-accent-1 before:shadow-[0_0_8px_var(--accent-1)] before:content-['']"
      >
        {title}
      </h3>
      {children}
    </section>
  )
}

export function SettingSwitch({
  label,
  description,
  checked,
  onCheckedChange
}: {
  label: string
  description?: string
  checked: boolean
  onCheckedChange(checked: boolean): void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[12px] text-text-primary/85">
          {label}
        </label>
        {description && (
          <p
            id={`${id}-description`}
            className="mt-0.5 text-[11px] leading-snug text-text-tertiary"
          >
            {description}
          </p>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={description ? `${id}-description` : undefined}
      />
    </div>
  )
}

export function SettingSlider({
  label,
  value,
  min,
  max,
  unit,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  /** Shown after the value: "%" → "40%", " px" → "16 px". */
  unit: string
  onChange(value: number): void
}): React.JSX.Element {
  const shown = Math.min(Math.max(Math.round(value), min), max)
  const text = `${shown}${unit}`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[11px] text-text-tertiary">
        <span aria-hidden="true">{label}</span>
        <span className="text-text-secondary tabular-nums" aria-hidden="true">
          {text}
        </span>
      </div>
      <Slider
        aria-label={label}
        valueText={text}
        min={min}
        max={max}
        step={1}
        value={[shown]}
        onValueChange={([next]) => onChange(next)}
      />
    </div>
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: string
}

export function SegmentedRadio<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly SegmentOption<T>[]
  onChange(value: T): void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-[11px] text-text-tertiary">
        {label}
      </span>
      <RadioGroup.Root
        aria-labelledby={id}
        value={value}
        onValueChange={(next) => onChange(next as T)}
        orientation="horizontal"
        className="grid auto-cols-fr grid-flow-col gap-1 rounded-[10px] bg-text-primary/5 p-1"
      >
        {options.map((option) => (
          <RadioGroup.Item
            key={option.value}
            value={option.value}
            className={cn(
              'rounded-[7px] px-2 py-1 text-[12px] text-text-secondary transition-colors outline-none',
              'hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-1',
              'data-[state=checked]:bg-accent-2/25 data-[state=checked]:font-medium data-[state=checked]:text-text-primary',
              'data-[state=checked]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent-1)_45%,transparent)]'
            )}
          >
            {option.label}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  )
}

/** A plain inspector button (Data section). */
export function InspectorButton({
  children,
  onClick,
  tone = 'default'
}: {
  children: ReactNode
  onClick(): void
  tone?: 'default' | 'danger'
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[12px] transition-colors outline-none',
        'bg-text-primary/5 hover:bg-text-primary/10 focus-visible:ring-2 focus-visible:ring-accent-1',
        tone === 'danger' ? 'text-red-600 dark:text-red-300' : 'text-text-primary/90',
        '[&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:opacity-80'
      )}
    >
      {children}
    </button>
  )
}
