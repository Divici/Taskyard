import type { DesktopItem } from '@shared/schema'

/**
 * The label Explorer would show: shortcuts (`.lnk`, `.url`) and folders never show an
 * extension; other files show it when Settings → show extensions is on.
 */
export function displayName(
  item: Pick<DesktopItem, 'name' | 'ext' | 'kind'>,
  showExtension: boolean
): string {
  const hidden = item.kind === 'link' || item.kind === 'url' || item.kind === 'folder'
  return showExtension && !hidden ? `${item.name}${item.ext}` : item.name
}

/** The DOM id of an item's option (roving focus moves focus by id). */
export function optionDomId(scope: string, id: string): string {
  return `item-${scope}-${id.replace(':', '-')}`
}
