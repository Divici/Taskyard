import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { realWin32TestsEnabled } from '../test/win32-opt-in'
import { loadWin32Bindings, type Koffi } from './bindings'
import type {
  BackgroundSource,
  ShellMenuApi,
  ShellMenuItem,
  ShowMenuRequest
} from './shell-menu-api'
import { createKoffiShellMenuApi } from './shell-menu-koffi'
import { shellMenuStructs } from './shell-menu-native'

// Opt-in: npm run test:win32. Builds real shell context menus (QueryContextMenu + the
// WM_INITMENUPOPUP forwarding) for TEMP folders and files only, and reads their items. The real
// Desktop background menu is built, shaped and read, never shown or invoked. The clipboard test
// invokes copy / cut / paste on TEMP files only — and OVERWRITES THE USER'S CLIPBOARD.

function verbs(items: ShellMenuItem[]): string[] {
  return items.flatMap((item) => [...(item.verb ? [item.verb] : []), ...verbs(item.submenu ?? [])])
}

function submenuWith(items: ShellMenuItem[], verb: string): ShellMenuItem | undefined {
  return items.find((item) => item.submenu?.some((child) => child.verb === verb))
}

describe.runIf(realWin32TestsEnabled())('koffi shell menus (real shell32)', () => {
  let koffi: Koffi
  let api: ShellMenuApi
  let dir: string
  let fileA: string
  let fileB: string
  let pasteProbes = 0

  beforeAll(async () => {
    koffi = (await import('koffi')).default
    // Regression: the app's other koffi declarations (anonymous protos) come first, as in a
    // process that loaded them — pointer types to anonymous structs could then resolve to a
    // cached function-pointer type of the same anonymous name.
    loadWin32Bindings(koffi)
    for (let i = 0; i < 150; i++) koffi.pointer(koffi.proto('__stdcall', null, 'int', ['int']))
    api = createKoffiShellMenuApi(koffi, { onPasteProbe: () => pasteProbes++ })
    dir = mkdtempSync(join(tmpdir(), 'taskyard-shell-menu-'))
    fileA = join(dir, 'a.txt')
    fileB = join(dir, 'b.txt')
    writeFileSync(fileA, 'a')
    writeFileSync(fileB, 'b')
  })

  afterAll(() => {
    api?.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('declares the x64 structs at the Windows SDK sizes', () => {
    const structs = shellMenuStructs(koffi)
    expect(koffi.sizeof(structs.MENUITEMINFOW)).toBe(80)
    expect(koffi.sizeof(structs.CMINVOKECOMMANDINFOEX_ID)).toBe(104)
    expect(koffi.sizeof(structs.CMINVOKECOMMANDINFOEX_VERB)).toBe(104)
    expect(koffi.sizeof(structs.DEFCONTEXTMENU)).toBe(72)
    expect(koffi.sizeof(structs.WNDCLASSEXW)).toBe(80)
    expect(koffi.offsetof(structs.CMINVOKECOMMANDINFOEX_ID, 'ptInvoke')).toBe(96)
    expect(koffi.offsetof(structs.MENUITEMINFOW, 'hSubMenu')).toBe(24)
  })

  it('builds a temp folder background menu with New ▸ populated after WM_INITMENUPOPUP', () => {
    const items = api.enumerate({ kind: 'folder-background', path: dir }, { extendedVerbs: false })
    const newMenu = submenuWith(items, 'NewFolder')
    expect(newMenu?.label).toBe('New')
    expect(newMenu!.submenu!.filter((item) => !item.separator).length).toBeGreaterThanOrEqual(2)
    expect(verbs(items)).toEqual(expect.arrayContaining(['NewFolder', 'properties', 'refresh']))
    // Items carry the labels Windows shows, without mnemonics.
    expect(items.some((item) => item.label === 'Refresh')).toBe(true)
  })

  it('builds a file menu for one temp file with the usual verbs', () => {
    const items = api.enumerate({ kind: 'items', paths: [fileA] }, { extendedVerbs: false })
    expect(verbs(items)).toEqual(
      expect.arrayContaining(['open', 'cut', 'copy', 'link', 'delete', 'rename', 'properties'])
    )
    const sendTo = items.find((item) => item.label === 'Send to')
    expect(sendTo?.submenu?.length).toBeGreaterThanOrEqual(2)
  })

  it('builds one menu for two temp files that share a folder', () => {
    const items = api.enumerate({ kind: 'items', paths: [fileA, fileB] }, { extendedVerbs: true })
    expect(verbs(items)).toEqual(expect.arrayContaining(['copy', 'delete', 'properties']))
  })

  it.each<BackgroundSource>(['shell-view', 'view-object', 'default-menu'])(
    'reads the real Desktop background menu through %s (New ▸, Display settings, Personalize)',
    (source) => {
      const items = api.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false, source })
      const newMenu = submenuWith(items, 'NewFolder')
      expect(newMenu!.submenu!.filter((item) => !item.separator).length).toBeGreaterThanOrEqual(2)
      expect(verbs(items)).toEqual(expect.arrayContaining(['Display', 'Personalize']))
    }
  )

  it('only the shell view background (the chosen API) has Paste, View and Refresh', () => {
    const shellView = verbs(
      api.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false, source: 'shell-view' })
    )
    expect(shellView).toEqual(
      expect.arrayContaining(['paste', 'refresh', 'viewlogicaliconslarge', 'sortascending'])
    )
    for (const source of ['view-object', 'default-menu'] as const) {
      const other = verbs(
        api.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false, source })
      )
      expect(other).not.toContain('paste')
    }
  })

  it('fails cleanly for a path that does not exist and for a verb no handler knows', () => {
    expect(() =>
      api.enumerate({ kind: 'items', paths: [join(dir, 'missing.txt')] }, { extendedVerbs: false })
    ).toThrow(/SHParseDisplayName failed/)
    expect(() =>
      api.invokeVerb({ kind: 'items', paths: [fileA] }, 'taskyard-no-such-verb')
    ).toThrow(/InvokeCommand\(taskyard-no-such-verb\) failed/)
  })

  it('can be created twice in one process (named koffi types are reused, not redeclared)', () => {
    const second = createKoffiShellMenuApi(koffi)
    try {
      expect(
        second.enumerate({ kind: 'items', paths: [fileA] }, { extendedVerbs: false }).length
      ).toBeGreaterThan(0)
    } finally {
      second.dispose()
    }
  })

  it('never reads the clipboard or asks a drop target unless told (enumerate, preview, invoke)', () => {
    const before = pasteProbes
    api.enumerate({ kind: 'desktop-background' }, { extendedVerbs: false })
    api.enumerate({ kind: 'folder-background', path: dir }, { extendedVerbs: false })
    api.preview({
      target: { kind: 'desktop-background' },
      point: { x: 0, y: 0 },
      extendedVerbs: false,
      taskyardItems: [],
      interceptVerbs: [],
      interceptSubmenus: [],
      hideVerbs: [],
      hideSubmenus: [],
      replaceSubmenus: []
    })
    expect(pasteProbes).toBe(before)
    api.enumerate(
      { kind: 'folder-background', path: dir },
      { extendedVerbs: false, pasteState: true }
    )
    expect(pasteProbes).toBe(before + 1)
  })

  it('runs in an OLE single-threaded apartment', () => {
    const type: [number] = [-1]
    const qualifier: [number] = [0]
    const CoGetApartmentType = koffi
      .load('ole32.dll')
      .func('long __stdcall CoGetApartmentType(_Out_ int *type, _Out_ int *qualifier)')
    expect(CoGetApartmentType(type, qualifier)).toBe(0)
    expect([0, 3]).toContain(type[0]) // APTTYPE_STA or APTTYPE_MAINSTA
  })

  it('copies and cuts through the OLE clipboard: Paste turns enabled and pastes (overwrites the clipboard)', async () => {
    const target = join(dir, 'paste-here')
    mkdirSync(target, { recursive: true })
    const pasteItem = (): ShellMenuItem | undefined =>
      api
        .enumerate(
          { kind: 'folder-background', path: target },
          { extendedVerbs: false, pasteState: true }
        )
        .find((item) => item.verb === 'paste')
    const waitFor = async (done: () => boolean): Promise<boolean> => {
      for (let i = 0; i < 50 && !done(); i++) {
        api.pumpMessages()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return done()
    }

    api.invokeVerb({ kind: 'items', paths: [fileA] }, 'copy')
    const IsClipboardFormatAvailable = koffi
      .load('user32.dll')
      .func('int __stdcall IsClipboardFormatAvailable(uint32_t format)')
    expect(IsClipboardFormatAvailable(15)).not.toBe(0) // CF_HDROP, flushed after the copy
    expect(pasteItem()?.disabled).toBe(false)
    api.invokeVerb({ kind: 'folder-background', path: target }, 'paste')
    expect(await waitFor(() => existsSync(join(target, 'a.txt')))).toBe(true)
    expect(existsSync(fileA)).toBe(true)

    const moving = join(dir, 'move-me.txt')
    writeFileSync(moving, 'm')
    api.invokeVerb({ kind: 'items', paths: [moving] }, 'cut')
    api.invokeVerb({ kind: 'folder-background', path: target }, 'paste')
    expect(
      await waitFor(() => existsSync(join(target, 'move-me.txt')) && !existsSync(moving))
    ).toBe(true)
  })

  it('shapes the real Desktop menu with the Phase 3 recipe (preview only, nothing shown)', () => {
    const request: ShowMenuRequest = {
      target: { kind: 'desktop-background' },
      point: { x: 0, y: 0 },
      extendedVerbs: false,
      taskyardItems: [
        {
          kind: 'submenu',
          label: 'Taskyard',
          items: [{ kind: 'item', id: 'new-group', label: 'New group here' }]
        }
      ],
      interceptVerbs: ['refresh'],
      interceptSubmenus: [],
      hideVerbs: ['viewcolsettings'],
      hideSubmenus: ['groupascending'],
      replaceSubmenus: [
        {
          match: { verb: 'viewlogicaliconslarge' },
          items: [
            {
              kind: 'item',
              id: 'icon-large',
              label: 'L',
              labelFrom: { verb: 'viewlogicaliconslarge' },
              radio: true,
              checked: true
            },
            {
              kind: 'item',
              id: 'icon-medium',
              label: 'M',
              labelFrom: { verb: 'viewlogicaliconsmedium' },
              radio: true
            },
            {
              kind: 'item',
              id: 'icon-small',
              label: 'S',
              labelFrom: { verb: 'viewlogicaliconssmall' },
              radio: true
            },
            { kind: 'separator' },
            { kind: 'item', id: 'auto-arrange', label: 'AA', labelFrom: { verb: 'arrangeauto' } },
            {
              kind: 'item',
              id: 'grid-snap',
              label: 'AG',
              labelFrom: { verb: 'arrangeautogrid' },
              checked: true
            },
            { kind: 'separator' },
            { kind: 'item', id: 'show-icons', label: 'Show desktop icons', checked: true }
          ]
        },
        {
          match: { verb: 'sortascending' },
          items: [0, 1, 2, 3].map((index) => ({
            kind: 'item' as const,
            id: `sort-${index}`,
            label: `column ${index}`,
            labelFrom: { submenu: 'sortascending', index }
          }))
        }
      ]
    }
    const menu = api.preview(request)
    const labels = menu.map((item) => (item.separator ? '---' : item.label))
    expect(labels.slice(0, 4)).toEqual(['Taskyard', '---', 'View', 'Sort by'])
    expect(labels).not.toContain('Group by')
    expect(labels).toContain('Refresh')
    const view = menu.find((item) => item.label === 'View')!.submenu!
    expect(view.map((item) => (item.separator ? '---' : item.label))).toEqual([
      'Large icons',
      'Medium icons',
      'Small icons',
      '---',
      'Auto arrange',
      'Align to grid',
      '---',
      'Show desktop icons'
    ])
    expect(view.filter((item) => item.checked).map((item) => item.label)).toEqual([
      'Large icons',
      'Align to grid',
      'Show desktop icons'
    ])
    expect(view.filter((item) => item.radio).length).toBe(3)
    expect(view.every((item) => item.separator || (item.id >= 0x8000 && !item.disabled))).toBe(true)
    const sort = menu.find((item) => item.label === 'Sort by')!.submenu!
    expect(sort.map((item) => item.label)).toEqual(['Name', 'Size', 'Item type', 'Date modified'])
  })

  it('survives many build/release cycles (no leaked menus, windows or COM objects)', () => {
    for (let i = 0; i < 20; i++) {
      api.enumerate({ kind: 'items', paths: [fileA] }, { extendedVerbs: false })
      api.enumerate({ kind: 'folder-background', path: dir }, { extendedVerbs: false })
    }
  })
})
