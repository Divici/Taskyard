/**
 * The Electron half of `npm run spike:shell-menu` (bundled by scripts/spike-shell-menu.ts and run
 * as an Electron main process). It drives the real shell-menu helper (out/main/shell-menu-helper.js)
 * through the app's own host, exactly as Taskyard's main process will:
 *
 * 1. enumerate a TEMP folder's background menu and a TEMP file's menu in the helper;
 * 2. survive a failing request (missing path) and keep the same helper;
 * 3. real right-click on a small window of ours → AllowSetForegroundWindow(helper) → show the TEMP
 *    folder's background menu with Taskyard items on top; check the helper owns the foreground,
 *    read the live menu, capture a screenshot, pick "Spike: pick me" with the keyboard (Down,
 *    Enter) → the Taskyard id comes back;
 * 4. show again, walk to New ▸ with the keyboard and open it (the live WM_INITMENUPOPUP
 *    forwarding fills it), capture it, dismiss with Esc;
 * 5. show again and dismiss programmatically with WM_CANCELMODE to the menu's owner window;
 * 5a. open View ▸ — replaced by Taskyard's (Windows' labels, radio/checked marks) — and choose
 *     "Small icons" → the Taskyard id comes back;
 * 5b. choose Refresh with the keyboard → handed back as intercepted (never invoked);
 * 5c. choose Properties with the keyboard → invoked in the helper by command id (the path every
 *     native choice takes) → the TEMP folder's Properties dialog opens; close it;
 * 6. invoke `properties` on the TEMP file without a menu, find the dialog, close it;
 * 6b. OLE clipboard: `copy` the TEMP file (OVERWRITES THE USER'S CLIPBOARD), the TEMP folder's
 *     Paste turns enabled, and `paste` into a TEMP subfolder creates the copy;
 * 7. kill the helper; the next request respawns it.
 *
 * Nothing touches the real Desktop. Results go to SPIKE_OUT/result.json (+ PNG captures).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, desktopCapturer, nativeImage, screen, utilityProcess } from 'electron'
import koffi from 'koffi'
import { createAppShellMenu } from '../../src/main/shell-menu/app-shell-menu'
import type { ShellMenuHost, ShowingInfo } from '../../src/main/shell-menu/host'
import { loadWin32Bindings, type Koffi } from '../../src/main/win32/bindings'
import type { ShowMenuOutcome, ShowMenuRequest } from '../../src/main/win32/shell-menu-api'
import {
  loadMenuInspector,
  VK_DOWN,
  VK_ESCAPE,
  VK_RETURN,
  VK_RIGHT,
  WM_CANCELMODE,
  WM_CLOSE,
  type MenuWindowInfo
} from './menu-inspect'

const HELPER = process.env['SPIKE_HELPER'] ?? ''
const DIR = process.env['SPIKE_DIR'] ?? ''
const OUT = process.env['SPIKE_OUT'] ?? ''
const FILE = join(DIR, 'a.txt')
const KEY_SETTLE_MS = 150
const POLL_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function waitFor<T>(check: () => T | null | undefined, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== null && value !== undefined) return value
    if (Date.now() > deadline) return null
    await sleep(POLL_MS)
  }
}

const result: Record<string, unknown> = { started: new Date().toISOString() }
const failures: string[] = []
const check = (ok: boolean, what: string): void => {
  if (!ok) failures.push(what)
}

/** A PNG of the screen area the menus cover (rects in physical pixels), from their display. */
async function capture(menus: MenuWindowInfo[], name: string): Promise<string | null> {
  if (menus.length === 0) return null
  const anchor = screen.screenToDipPoint({ x: menus[0].rect.left, y: menus[0].rect.top })
  const display = screen.getDisplayNearestPoint(anchor)
  const origin = screen.dipToScreenRect(null, display.bounds)
  const size = { width: origin.width, height: origin.height }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!source) return null
  const pad = 4
  const left = Math.max(0, Math.min(...menus.map((m) => m.rect.left)) - origin.x - pad)
  const top = Math.max(0, Math.min(...menus.map((m) => m.rect.top)) - origin.y - pad)
  const right = Math.min(size.width, Math.max(...menus.map((m) => m.rect.right)) - origin.x + pad)
  const bottom = Math.min(
    size.height,
    Math.max(...menus.map((m) => m.rect.bottom)) - origin.y + pad
  )
  if (right <= left || bottom <= top) return null
  const image = source.thumbnail.crop({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  })
  // Only the menus are kept: whatever else is on the user's screen is painted over (gray).
  const { width, height } = image.getSize()
  const pixels = Buffer.from(image.toBitmap())
  const inMenu = (x: number, y: number): boolean =>
    menus.some(
      (m) =>
        x + left + origin.x >= m.rect.left &&
        x + left + origin.x < m.rect.right &&
        y + top + origin.y >= m.rect.top &&
        y + top + origin.y < m.rect.bottom
    )
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (inMenu(x, y)) continue
      const at = (y * width + x) * 4
      pixels.fill(0x80, at, at + 3)
      pixels[at + 3] = 0xff
    }
  }
  const masked = nativeImage.createFromBitmap(pixels, { width, height })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, masked.toPNG())
  return file
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const k = koffi as unknown as Koffi
  const bindings = loadWin32Bindings(k)
  const inspect = loadMenuInspector(k)
  const log = {
    info: (message: string) => console.log(`[host] ${message}`),
    warn: (message: string, ...details: unknown[]) => console.warn(`[host] ${message}`, ...details),
    error: (message: string, ...details: unknown[]) =>
      console.error(`[host] ${message}`, ...details)
  }
  const allowed: boolean[] = []
  const host: ShellMenuHost = createAppShellMenu({
    utilityProcess,
    helperFile: HELPER,
    win32: {
      allowSetForegroundWindow: (pid) => {
        const ok = bindings.AllowSetForegroundWindow(pid)
        allowed.push(ok)
        return ok
      }
    },
    log
  })
  let showing: (ShowingInfo & { at: number }) | null = null
  host.onShowing((info) => (showing = { ...info, at: Date.now() }))

  const started = Date.now()
  const { pid } = await host.start()
  result['helper'] = { pid, startMs: Date.now() - started }

  // 1. Enumerate in the helper (TEMP only).
  const enumStart = Date.now()
  const folderItems = await host.enumerate({ kind: 'folder-background', path: DIR })
  const fileItems = await host.enumerate({ kind: 'items', paths: [FILE] })
  result['enumerate'] = {
    ms: Date.now() - enumStart,
    folderBackground: folderItems,
    file: fileItems
  }
  const newMenu = folderItems.find((item) =>
    item.submenu?.some((child) => child.verb === 'NewFolder')
  )
  check(
    (newMenu?.submenu?.filter((c) => !c.separator).length ?? 0) >= 2,
    'helper: New ▸ has ≥ 2 items'
  )

  // 2. A failing request is reported; the helper stays.
  const failure = await host
    .invokeVerb({ kind: 'items', paths: [join(DIR, 'missing.txt')] }, 'properties')
    .then(
      () => 'resolved',
      (error: Error & { code?: string }) => `${error.code}: ${error.message}`
    )
  const afterFailure = await host.enumerate({ kind: 'items', paths: [FILE] })
  result['failure'] = {
    rejection: failure,
    samePid: host.helper?.pid === pid,
    itemsAfter: afterFailure.length
  }
  check(
    failure.startsWith('request-failed'),
    'failure: a missing path is a request-failed rejection'
  )
  check(host.helper?.pid === pid, 'failure: the helper survived')

  // A small window of ours to right-click, like Taskyard's desktop window.
  const window = new BrowserWindow({
    width: 420,
    height: 260,
    x: 800,
    y: 420,
    alwaysOnTop: true,
    show: false,
    title: 'Taskyard shell-menu spike'
  })
  await window.loadURL(
    'data:text/html,<body style="background:%23102040;color:white;font:16px Segoe UI">Taskyard shell-menu spike: right-click target</body>'
  )
  window.show()
  await sleep(400)
  const savedCursor = inspect.cursor()
  const bounds = window.getBounds()
  const target = screen.dipToScreenPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  })

  const request = (): ShowMenuRequest => ({
    target: { kind: 'folder-background', path: DIR },
    // The right-click point itself (the real cursor may have moved since).
    point: { x: target.x, y: target.y },
    extendedVerbs: false,
    taskyardItems: [
      { kind: 'item', id: 'spike-pick', label: 'Spike: pick me' },
      {
        kind: 'submenu',
        label: 'Taskyard',
        items: [
          { kind: 'item', id: 'new-group', label: 'New group here' },
          { kind: 'separator' },
          { kind: 'item', id: 'settings', label: 'Taskyard settings' }
        ]
      }
    ],
    // The Phase 3 recipe (report: "Phase 3 recipe"), on a TEMP folder instead of the Desktop.
    interceptVerbs: ['refresh'],
    interceptSubmenus: [],
    hideVerbs: ['viewcustomwizard', 'viewcolsettings'],
    hideSubmenus: ['groupascending'],
    replaceSubmenus: [
      {
        match: { verb: 'viewlogicaliconslarge' },
        items: [
          {
            kind: 'item',
            id: 'icon-large',
            label: 'Large icons',
            labelFrom: { verb: 'viewlogicaliconslarge' },
            radio: true
          },
          {
            kind: 'item',
            id: 'icon-medium',
            label: 'Medium icons',
            labelFrom: { verb: 'viewlogicaliconsmedium' },
            radio: true,
            checked: true
          },
          {
            kind: 'item',
            id: 'icon-small',
            label: 'Small icons',
            labelFrom: { verb: 'viewlogicaliconssmall' },
            radio: true
          },
          { kind: 'separator' },
          {
            kind: 'item',
            id: 'auto-arrange',
            label: 'Auto arrange icons',
            labelFrom: { verb: 'arrangeauto' }
          },
          {
            kind: 'item',
            id: 'grid-snap',
            label: 'Align icons to grid',
            labelFrom: { verb: 'arrangeautogrid' },
            checked: true
          },
          { kind: 'separator' },
          { kind: 'item', id: 'show-icons', label: 'Show desktop icons', checked: true }
        ]
      },
      {
        match: { verb: 'sortascending' },
        items: ['name', 'size', 'type', 'date'].map((column, index) => ({
          kind: 'item' as const,
          id: `sort-${column}`,
          label: column,
          labelFrom: { submenu: 'sortascending', index }
        }))
      }
    ]
  })

  /** Real right-click → show → run `act` while the menu is up → the outcome. */
  const round = async (
    name: string,
    act: (menus: MenuWindowInfo[], owner: bigint) => Promise<void>
  ): Promise<Record<string, unknown>> => {
    showing = null
    const contextMenu = new Promise<void>((done) =>
      window.webContents.once('context-menu', () => done())
    )
    inspect.rightClickAt(target.x, target.y)
    await Promise.race([contextMenu, sleep(3000)])
    const asked = Date.now()
    const allowBefore = allowed.length
    const outcome = host.show(request())
    const shownInfo = await waitFor(() => showing, 10_000)
    const menus =
      (await waitFor(() => {
        const found = inspect.menuWindows(host.helper?.pid ?? -1)
        return found.length > 0 ? found : null
      }, 5000)) ?? []
    await sleep(250)
    const foreground = inspect.foregroundWindow()
    const record: Record<string, unknown> = {
      contextMenuEvent: true,
      allowSetForegroundWindow: allowed[allowBefore] ?? null,
      showingMs: shownInfo ? shownInfo.at - asked : null,
      ownerHwnd: shownInfo ? String(shownInfo.ownerHwnd) : null,
      foregroundIsOwner: shownInfo !== null && foreground === shownInfo.ownerHwnd,
      menu: menus[0] ?? null
    }
    if (shownInfo) await act(menus, shownInfo.ownerHwnd)
    record['outcome'] = await Promise.race([
      outcome,
      sleep(8000).then((): ShowMenuOutcome | string => 'no outcome within 8 s')
    ])
    await sleep(200)
    record['menusAfter'] = inspect.menuWindows(host.helper?.pid ?? -1).length
    result[name] = record
    check(
      record['foregroundIsOwner'] === true,
      `${name}: the helper's owner window had the foreground`
    )
    check(menus.length > 0, `${name}: a visible #32768 menu of the helper`)
    check(record['menusAfter'] === 0, `${name}: the menu closed`)
    return record
  }

  try {
    // 3. Keyboard pick of a Taskyard item.
    const pick = await round('keyboardPick', async (menus) => {
      result['keyboardPickCapture'] = await capture(menus, 'menu-shown')
      inspect.pressKey(VK_DOWN)
      await sleep(KEY_SETTLE_MS)
      inspect.pressKey(VK_RETURN)
    })
    check(
      JSON.stringify(pick['outcome']) === JSON.stringify({ kind: 'taskyard', id: 'spike-pick' }),
      'keyboardPick: Down + Enter chose "Spike: pick me" (id mapped back)'
    )
    const labels = (pick['menu'] as MenuWindowInfo | null)?.labels ?? []
    check(
      labels[0] === 'Spike: pick me' && labels[1] === 'Taskyard',
      'keyboardPick: Taskyard items on top'
    )
    check(!labels.some((label) => label.includes('Customize')), 'keyboardPick: hidden verb removed')
    check(!labels.some((label) => label.includes('Grou')), 'keyboardPick: hidden submenu removed')

    // 4. Open New ▸ live with the keyboard; it fills through WM_INITMENUPOPUP forwarding.
    const newRound = await round('newSubmenu', async (menus, owner) => {
      let highlighted: string | null = null
      for (let step = 0; step < 40; step++) {
        inspect.pressKey(VK_DOWN)
        await sleep(60)
        highlighted = inspect.menuWindows(host.helper?.pid ?? -1)[0]?.highlighted ?? null
        if (highlighted?.replace(/&/g, '') === 'New') break
      }
      inspect.pressKey(VK_RIGHT)
      const opened = await waitFor(() => {
        const found = inspect.menuWindows(host.helper?.pid ?? -1)
        return found.length >= 2 ? found : null
      }, 3000)
      result['newSubmenuWindows'] = opened
      result['newSubmenuCapture'] = opened ? await capture(opened, 'new-submenu') : null
      inspect.pressKey(VK_ESCAPE)
      await sleep(KEY_SETTLE_MS)
      inspect.pressKey(VK_ESCAPE)
      await sleep(KEY_SETTLE_MS)
      if (inspect.menuWindows(host.helper?.pid ?? -1).length > 0)
        inspect.postMessage(owner, WM_CANCELMODE)
      void menus
    })
    const opened = (result['newSubmenuWindows'] as MenuWindowInfo[] | null) ?? []
    const newItems = opened.find((menu) => menu.labels.some((label) => label.includes('Folder')))
    check(
      newItems !== undefined && newItems.labels.filter((l) => l !== '---').length >= 2,
      'newSubmenu: New ▸ filled live'
    )
    check(
      JSON.stringify(newRound['outcome']) === JSON.stringify({ kind: 'dismissed' }),
      'newSubmenu: Esc dismissed'
    )

    /** Walks the highlight down to `label` (mnemonics ignored), then presses Enter. */
    const choose = async (label: string): Promise<boolean> => {
      for (let step = 0; step < 40; step++) {
        inspect.pressKey(VK_DOWN)
        await sleep(60)
        const highlighted = inspect.menuWindows(host.helper?.pid ?? -1)[0]?.highlighted ?? null
        if (highlighted?.replace(/&/g, '').split('\t')[0] === label) {
          inspect.pressKey(VK_RETURN)
          return true
        }
      }
      return false
    }

    // 5a. View ▸ replaced by Taskyard's submenu: Windows' labels, radio/checked marks, id back.
    const view = await round('viewReplaced', async (_menus, owner) => {
      let onView = false
      for (let step = 0; step < 40 && !onView; step++) {
        inspect.pressKey(VK_DOWN)
        await sleep(60)
        const top = inspect.menuWindows(host.helper?.pid ?? -1)[0]?.highlighted ?? ''
        onView = top.replace(/&/g, '') === 'View'
      }
      inspect.pressKey(VK_RIGHT)
      const opened = await waitFor(() => {
        const found = inspect.menuWindows(host.helper?.pid ?? -1)
        return found.find((menu) => menu.labels.includes('Small icons')) ?? null
      }, 3000)
      result['viewReplacedSubmenu'] = opened
      result['viewReplacedCapture'] = opened ? await capture([opened], 'view-replaced') : null
      let chosen = false
      for (let step = 0; step < 12 && opened && !chosen; step++) {
        const sub = inspect
          .menuWindows(host.helper?.pid ?? -1)
          .find((menu) => menu.labels.includes('Small icons'))
        if (sub?.highlighted === 'Small icons') {
          inspect.pressKey(VK_RETURN)
          chosen = true
        } else {
          inspect.pressKey(VK_DOWN)
          await sleep(60)
        }
      }
      if (!chosen) inspect.postMessage(owner, WM_CANCELMODE)
    })
    const viewSubmenu = result['viewReplacedSubmenu'] as MenuWindowInfo | null
    check(
      JSON.stringify(viewSubmenu?.labels) ===
        JSON.stringify([
          'Large icons',
          'Medium icons',
          'Small icons',
          '---',
          'Auto arrange',
          'Align to grid',
          '---',
          'Show desktop icons'
        ]),
      'viewReplaced: View ▸ holds Taskyard items with Windows labels'
    )
    check(
      JSON.stringify(viewSubmenu?.checked) ===
        JSON.stringify(['Medium icons', 'Align to grid', 'Show desktop icons']) &&
        JSON.stringify(viewSubmenu?.radio) ===
          JSON.stringify(['Large icons', 'Medium icons', 'Small icons']),
      'viewReplaced: checks and radio bullets as requested'
    )
    check(
      JSON.stringify(view['outcome']) === JSON.stringify({ kind: 'taskyard', id: 'icon-small' }),
      'viewReplaced: "Small icons" came back as its Taskyard id'
    )
    const topLabels = ((view['menu'] as MenuWindowInfo | null)?.labels ?? []).map((label) =>
      label.replace(/&/g, '')
    )
    check(
      topLabels.includes('View') &&
        topLabels.includes('Sort by') &&
        !topLabels.includes('Group by'),
      'viewReplaced: View ▸ and Sort by ▸ kept their places, Group by ▸ hidden'
    )

    // 5b. An intercepted verb comes back to Taskyard instead of being invoked.
    const refresh = await round('interceptRefresh', async () => {
      result['interceptRefreshFound'] = await choose('Refresh')
    })
    check(
      JSON.stringify(refresh['outcome']) ===
        JSON.stringify({ kind: 'intercepted', verb: 'refresh', label: 'Refresh', path: [] }),
      'interceptRefresh: Refresh handed back, not invoked'
    )

    // 5c. A shell item invoked by command id from the shown menu (InvokeCommand + ptInvoke).
    const folderName = DIR.split('\\').pop() ?? ''
    const properties = await round('invokeFromMenu', async () => {
      result['invokeFromMenuFound'] = await choose('Properties')
    })
    check(
      JSON.stringify(properties['outcome']) ===
        JSON.stringify({ kind: 'invoked', verb: 'properties', label: 'Properties', path: [] }),
      'invokeFromMenu: Properties invoked by command id'
    )
    const folderDialog = await waitFor(
      () =>
        inspect
          .windowsOf(host.helper?.pid ?? -1)
          .find(
            (w) => w.visible && w.title.includes(folderName) && w.title.includes('Properties')
          ) ?? null,
      8000
    )
    if (folderDialog) inspect.postMessage(folderDialog.hwnd, WM_CLOSE)
    const folderDialogClosed =
      folderDialog !== null &&
      (await waitFor(
        () =>
          inspect
            .windowsOf(host.helper?.pid ?? -1)
            .some((w) => w.hwnd === folderDialog.hwnd && w.visible)
            ? null
            : true,
        5000
      )) === true
    result['invokeFromMenuDialog'] = folderDialog
      ? { title: folderDialog.title, className: folderDialog.className, closed: folderDialogClosed }
      : null
    check(
      folderDialog !== null && folderDialogClosed,
      'invokeFromMenu: the folder Properties dialog opened and closed'
    )

    // 5. Programmatic dismissal of that menu only (WM_CANCELMODE to its owner window).
    const cancel = await round('cancelMode', async (_menus, owner) => {
      inspect.postMessage(owner, WM_CANCELMODE)
    })
    check(
      JSON.stringify(cancel['outcome']) === JSON.stringify({ kind: 'dismissed' }),
      'cancelMode: dismissed'
    )
  } finally {
    inspect.moveCursor(savedCursor.x, savedCursor.y)
    window.destroy()
  }

  // 6. Invoke a verb without a menu: Properties of the TEMP file, then close the dialog.
  const helperPid = host.helper?.pid ?? -1
  await host.invokeVerb({ kind: 'items', paths: [FILE] }, 'properties')
  const dialog = await waitFor(
    () => inspect.windowsOf(helperPid).find((w) => w.visible && w.title.includes('a.txt')) ?? null,
    8000
  )
  let closed = false
  if (dialog) {
    inspect.postMessage(dialog.hwnd, WM_CLOSE)
    closed =
      (await waitFor(
        () =>
          inspect.windowsOf(helperPid).some((w) => w.hwnd === dialog.hwnd && w.visible)
            ? null
            : true,
        5000
      )) === true
  }
  result['invokeProperties'] = {
    dialog: dialog ? { title: dialog.title, className: dialog.className } : null,
    closed
  }
  check(dialog !== null, 'invoke: the Properties dialog opened (verb invoked without a menu)')
  check(closed, 'invoke: the Properties dialog closed')

  // 6b. The OLE clipboard in the helper. NOTE: this overwrites the user's clipboard.
  const pasted = join(DIR, 'pasted')
  mkdirSync(pasted, { recursive: true })
  const pasteBefore = (
    await host.enumerate({ kind: 'folder-background', path: pasted }, { pasteState: true })
  ).find((item) => item.verb === 'paste')
  await host.invokeVerb({ kind: 'items', paths: [FILE] }, 'copy')
  const pasteAfter = (
    await host.enumerate({ kind: 'folder-background', path: pasted }, { pasteState: true })
  ).find((item) => item.verb === 'paste')
  await host.invokeVerb({ kind: 'folder-background', path: pasted }, 'paste')
  const copied = await waitFor(() => (existsSync(join(pasted, 'a.txt')) ? true : null), 8000)
  result['clipboard'] = {
    note: 'overwrote the user clipboard with the TEMP file',
    pasteBefore: pasteBefore ? { disabled: pasteBefore.disabled } : null,
    pasteAfterCopy: pasteAfter ? { disabled: pasteAfter.disabled } : null,
    pastedFile: copied === true
  }
  check(pasteAfter !== undefined && !pasteAfter.disabled, 'clipboard: Paste enabled after copy')
  check(copied === true, 'clipboard: paste into a TEMP folder created the copy')

  // 7. The helper dies; the next request respawns it.
  const oldPid = host.helper?.pid ?? -1
  process.kill(oldPid)
  await waitFor(() => (host.helper === null ? true : null), 5000)
  const respawnItems = await host.enumerate({ kind: 'items', paths: [FILE] })
  result['respawn'] = { oldPid, newPid: host.helper?.pid ?? null, items: respawnItems.length }
  check(
    host.helper !== null && host.helper.pid !== oldPid,
    'respawn: a new helper served the next request'
  )

  const lastPid = host.helper?.pid ?? -1
  host.dispose()
  await sleep(500)
  result['strayHelperWindows'] = inspect.windowsOf(lastPid).length
  result['failures'] = failures
}

app.whenReady().then(
  async () => {
    try {
      await main()
    } catch (error) {
      failures.push(`threw: ${error instanceof Error ? error.stack : String(error)}`)
      result['failures'] = failures
    }
    writeFileSync(join(OUT, 'result.json'), JSON.stringify(result, null, 2))
    app.exit(failures.length === 0 ? 0 : 1)
  },
  () => app.exit(2)
)
app.on('window-all-closed', () => undefined)
