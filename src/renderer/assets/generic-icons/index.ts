import type { ItemKind } from '@shared/schema'
import app from './app.svg'
import file from './file.svg'
import folder from './folder.svg'
import link from './link.svg'
import url from './url.svg'

/**
 * Built-in icons by item kind (bundled SVG URLs). The renderer shows one whenever main has sent
 * no icon for an item: always for cloud placeholders and network shortcuts (main never reads
 * them), and until the real icon arrives or when every extraction step failed.
 */
export const GENERIC_ICONS: Readonly<Record<ItemKind, string>> = { app, file, folder, link, url }

export function genericIconUrl(kind: ItemKind): string {
  return GENERIC_ICONS[kind]
}
