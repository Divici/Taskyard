import { cn } from '../../lib/utils'

// Shared look and keyboard rules of the Timer and Stopwatch tools (round 2 extracted them from
// TimerTool so both tools line up on the same centre line with the same controls).

/** Controls that handle Space themselves (the view's Start/Pause shortcut skips them). */
export const SPACE_OWNERS = 'input, select, textarea, button, [contenteditable]'

/** The column every counting tool is laid out in: one centre line, evenly spaced. */
export const TOOL_COLUMN =
  'flex h-full min-h-0 flex-col items-center gap-2 overflow-y-auto rounded-[12px] px-1 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-accent-1/60'

/** Width of the rows under the ring (buttons, presets, fields), centred in the column. */
export const TOOL_ROW = 'w-full max-w-[260px]'

const BUTTON =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-full px-3.5 text-[12px] font-semibold transition-[background-color,color,box-shadow,opacity] duration-[180ms] focus-visible:ring-2 focus-visible:ring-accent-1 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40'

export const PRIMARY_BUTTON = cn(
  BUTTON,
  // The blue accent in both themes (light's accent-2 is cyan, too pale under white text).
  'bg-accent-2 text-white shadow-[0_0_14px_color-mix(in_srgb,var(--accent-2)_55%,transparent)] hover:brightness-110 [[data-theme=light]_&]:bg-accent-1 [[data-theme=light]_&]:shadow-[0_0_14px_color-mix(in_srgb,var(--accent-1)_45%,transparent)]'
)

export const SECONDARY_BUTTON = cn(
  BUTTON,
  'bg-white/10 text-text-primary hover:bg-white/20 [[data-theme=light]_&]:bg-black/5 [[data-theme=light]_&]:hover:bg-black/10'
)

export const FIELD =
  'h-6 rounded-[8px] border border-white/10 bg-black/25 px-2 text-[12px] text-text-primary outline-none focus:border-accent-1/60 focus:ring-2 focus:ring-accent-1/30 disabled:opacity-40 [[data-theme=light]_&]:border-black/10 [[data-theme=light]_&]:bg-white/60'
