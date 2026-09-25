// Class names that turn the shadcn context menu into Taskyard glass (tokens.css / glass.css).
// Menus are more opaque than groups so their text stays readable over any wallpaper.

export const MENU_CONTENT =
  'glass min-w-[14rem] rounded-[var(--radius-1)] border-[var(--glass-border)] bg-[rgb(var(--glass-tint)/max(var(--glass-alpha),0.82))] p-1.5 text-text-primary shadow-[var(--glow)]'

export const MENU_ITEM =
  'rounded-[8px] px-2.5 py-1.5 text-[13px] text-text-primary focus:bg-accent-2/25 focus:text-text-primary data-[state=open]:bg-accent-2/25 data-[state=open]:text-text-primary [&_svg:not([class*=text-])]:text-text-secondary'

export const MENU_SEPARATOR = 'my-1 bg-white/10 [[data-theme=light]_&]:bg-black/10'

export const MENU_SHORTCUT = 'text-[11px] tracking-normal text-text-tertiary'

/** Radio and checkbox items keep room for their indicator on the left. */
export const MENU_CHECK_ITEM = `${MENU_ITEM} pl-8`
