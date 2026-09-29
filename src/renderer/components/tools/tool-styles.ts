import { cn } from '../../lib/utils'

// Shared look and keyboard rules of the Timer and Stopwatch tools (round 2 extracted them from
// TimerTool so both tools line up on the same centre line with the same controls).

/** Controls that handle Space themselves (the view's Start/Pause shortcut skips them). */
export const SPACE_OWNERS = 'input, select, textarea, button, [contenteditable]'

/**
 * A tool's scroll body (2026-09-29, Decision 1): a flex column that fills the space it is given
 * and scrolls. Mark it `data-tool-body`; its one child is the content, marked `data-tool-content`
 * and styled with TOOL_CENTRED.
 */
export const TOOL_BODY = 'flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]'

/**
 * The content inside a TOOL_BODY. Auto margins share out the free space, so the block is centred
 * while it is shorter than the body; once it is taller they collapse to 0, so it starts at the
 * top and scrolls (`justify-center` would push its top out of reach instead).
 */
export const TOOL_CENTRED = 'my-auto w-full shrink-0'

/** A counting tool's view (Timer, Stopwatch): a focusable scroll body. */
export const TOOL_VIEW = cn(
  TOOL_BODY,
  'rounded-[12px] px-1 outline-none focus-visible:ring-2 focus-visible:ring-accent-1/60'
)

/** Its content: one centred column, one centre line, evenly spaced. */
export const TOOL_COLUMN = cn(TOOL_CENTRED, 'flex flex-col items-center gap-2')

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
