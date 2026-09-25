# Taskyard — desktop organizer (Fences-style) for Windows 11

**Mode:** greenfield · **Size:** XL · **Tier:** Deep
**Research:** `./research.md` · **Brief:** `./brief.md` (verbatim brief + design-input notes)

## Summary

Taskyard is an Electron app that owns the Windows desktop layer: one frameless, opaque window per monitor, seated directly above the shell's desktop window in the z-order, that paints a copy of the user's wallpaper and renders every Desktop-folder item as an icon, either free-floating or inside named glass groups. Real glass comes from blurring *our own* wallpaper copy with CSS `backdrop-filter`, because a transparent window cannot blur what is behind it and Windows acrylic is fragile for persistent panels (research: `electron-windows` Q2, `windows-desktop-shell` Q6). Files never move; the layout is metadata keyed by NTFS file id, so Explorer renames keep their placement and Explorer, other apps and Taskyard never disagree about where a file is. The to-do list and a countdown timer live in one floating glass "tools" widget with a side rail, sharing the group interaction model. Everything persists to versioned JSON in `userData` with atomic writes and restores on launch.

## Brief

See `./brief.md` (verbatim).

## Assumptions

All tagged `(assumed — not in brief)`. No deadline given — phases are ordered by risk, not calendar.

1. Windows 11 only (22H2+); no macOS/Linux builds. (assumed — not in brief)
2. Package manager is npm (only npm is installed). (assumed — not in brief)
3. Taskyard *covers* the real desktop; Explorer's icon layer is left untouched (no `HideIcons` registry write). First run ignores Explorer's undocumented icon positions; Auto-organize is offered instead. (assumed — not in brief)
4. Loose (ungrouped) items keep their own positions; a new file lands in the first free grid slot scanning column-first from the top-left, like Windows. (assumed — not in brief)
5. Items cannot be dragged between monitors; a group's context menu offers "Move to display". (assumed — not in brief)
6. Per-monitor wallpapers are read through `IDesktopWallpaper`; wallpapers Chromium cannot decode (HDR `.jxr`) fall back to Windows' transcoded JPEG cache, then to the solid desktop colour, with a settings hint. Windows Spotlight's "Learn about this picture" icon is covered by Taskyard. (assumed — not in brief)
7. Dropping a file from Explorer onto Taskyard **moves** it into the user's Desktop folder (same semantics as dropping on the Windows desktop) and shows a 6 s Undo toast. (assumed — not in brief)
8. Renaming an item in Taskyard renames the file on disk; deleting sends it to the Recycle Bin after a confirm dialog; both are disabled for items in read-only folders (Public Desktop for standard users). (assumed — not in brief)
9. "Minimize" a group = Fences-style roll-up to its title bar (double-click title or chevron). (assumed — not in brief)
10. Quick-hide (double-click empty desktop) and Peek (global shortcut `Ctrl+Alt+Space`, rebindable) are included as defining Fences behaviours. (assumed — not in brief)
11. Settings live in an in-canvas "inspector" panel (per `designInpo.html`), not a second window. Opening it raises Taskyard (Peek) so it is visible over other apps. (assumed — not in brief)
12. Start with Windows is on by default (toggle in settings and tray); the app runs from the tray with no taskbar button. (assumed — not in brief)
13. Data lives in `%APPDATA%\Taskyard\` as `layout.json`, `tasks.json`, `settings.json`, `ops.json` (move journal) plus `icons/` cache and `logs/`. (assumed — not in brief)
14. No telemetry, no auto-update, no cloud sync. Distribution is an NSIS installer built by electron-builder. (assumed — not in brief)
15. Icons: 32 px from Electron for every item, upgraded to `ceil(64 × scaleFactor)` px through Win32 `PrivateExtractIconsW` for `.exe/.ico` and shortcut targets on local drives; folders, documents, UNC-target shortcuts and OneDrive placeholders use 32 px or a built-in generic icon. (assumed — not in brief)
16. First run offers "Auto-organize" that creates four groups by type (Apps, Files, Folders, Web links). It is a choice, not forced. (assumed — not in brief)
17. Interactive Windows-only tests (`verify:zorder`, e2e) run on a developer machine or a self-hosted Windows runner with a logged-in desktop session; CI on hosted runners runs unit and component tests only. (assumed — not in brief)

## Research findings (the ones that changed a decision)

**Found**
- CSS `backdrop-filter` in a transparent Electron window blurs only the page's own content (electron/electron#30412, open since 2021). Confidence M → render our own wallpaper copy and blur that.
- Electron `BrowserWindow.type` has no Windows desktop value; z-order must be handled with Win32. Confidence M → Phase 2 spike with koffi.
- Win+D "first minimizes all windows that can be minimized, and then moves the desktop window to the top of the z-order" (Raymond Chen, https://devblogs.microsoft.com/oldnewthing/20241021-00/?p=110393; Rainmeter hit this on 24H2+, rainmeter/rainmeter#377). Confidence H → a non-minimizable window survives, but must be re-seated above the desktop window afterwards.
- `SetWindowSubclass` cannot cross threads; Electron's HWND lives on the main-process UI thread, which is the JS thread. koffi registered callbacks "can be called at any time"; an exception inside returns 0. Confidence M → subclass with try/catch, removed on `close`.
- Microsoft: acrylic is for transient surfaces, falls back to solid under Battery Saver / "Transparency effects off" / deactivation; window-vibrancy acrylic lags on drag. Confidence H/M → **no OS acrylic anywhere**.
- Electron's sandbox tutorial lists `webUtils` among modules available to sandboxed preloads (https://www.electronjs.org/docs/latest/tutorial/sandbox). Confidence H → `sandbox: true`.
- `app.getFileIcon` caps at 32×32 on Windows. Confidence H → Phase 5 64 px upgrade path.
- `SPIF_SENDCHANGE` broadcasts `WM_SETTINGCHANGE` on wallpaper change; `hookWindowMessage(0x001A)` detects it. Confidence H.
- On this machine 77 % of desktop items are `.lnk`/`.url`; `desktop.ini` is hidden/system; `Transcoded_003` exists next to `TranscodedWallpaper`, i.e. per-monitor wallpapers are in use. Confidence H.
- Node `fs.stat` exposes no Windows hidden/system attributes. Confidence H → `GetFileAttributesW` via koffi.
- Windows 11 24H2+ broke the WorkerW live-wallpaper trick (Lively #2464/#2695). Confidence M → **WorkerW parenting rejected**.
- dnd-kit classic is stable at 6.3.1; `PointerSensor` has a `distance` activation constraint; jsdom needs `getBoundingClientRect` mocks and has no `setPointerCapture`. Confidence M/H.
- koffi 3.3.1 native binary ships in a sibling `@koromix/*` package; `asarUnpack` must list both; no Electron ABI statement on koffi.dev. Confidence M/L → Phase 1 packaged smoke test.
- `prefers-reduced-transparency` supported since Chrome 118; Electron `nativeTheme.prefersReducedTransparency` mirrors the Windows setting.

**Inferred**
- A foreground borderless window covering an entire monitor can trip the shell's fullscreen heuristic (auto-hide taskbar stops sliding up). Phase 2 verifies; the window is inset 1 px at the bottom edge by default.

**Unknown** → handled in `research.md` § lead-verification.

## Decisions

Marked **[user]** (from the question round) or **[default]** (recommended, tagged).

1. **LOCKED: Electron 44 + koffi 3 for Win32** — because file icons, `.lnk` fallback, open-with-default and Recycle Bin are built in, no Rust toolchain exists, and ~15 Win32/COM calls are needed. Rejected: Tauri 2 (icon extraction, `.lnk` parsing and icon IPC all in Rust; transparency/acrylic regressions open; multi-GB toolchain), native C++ addon (node-gyp + MSVC for a dozen functions). Confidence H · Reversibility hard · [user]
2. **LOCKED: Desktop layer = one **opaque**, frameless, non-minimizable top-level window per display, seated directly above the shell desktop window (`GetShellWindow()` / the WorkerW hosting `SHELLDLL_DefView`) and kept there by (a) a `SetWindowSubclass` proc forcing `hwndInsertAfter` in `WM_WINDOWPOSCHANGING`, (b) a `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` sentinel plus 500 ms z-order poll that re-seats the window when the shell window ends up above it (Win+D, Explorer restart)** — because it needs no undocumented shell messages, and opacity sidesteps every transparent-window bug in research Q5 (we paint the wallpaper anyway). Rejected: `transparent:true` (Aero Snap/maximize/flicker bugs, no benefit), WorkerW parenting (broken on 24H2+, no reliable input), Electron-only `setAlwaysOnTop(false)` (rises on click). Confidence M · Reversibility medium · [default]
3. **LOCKED: Glass = CSS `backdrop-filter` over our own rendered wallpaper copy** — because the desktop window covers the whole monitor and the only thing behind it is the wallpaper, so blurring our copy is visually equivalent to compositor acrylic while staying per-region (crisp wallpaper between groups), 60 fps under drag, and independent of Battery Saver. OS acrylic itself is proven on this machine: `jane-ide` (Electron 44.4.3) uses `backgroundMaterial:'acrylic'` + `transparent:false` + `backgroundColor:'#00000000'` successfully (research § jane-ide precedent). Rejected: window-wide `backgroundMaterial` on the desktop window (blurs and tints the entire wallpaper — not Fences), one acrylic BrowserWindow per group (a renderer process per group, cross-window drag and drop, per-window z-order seating; conflicts with "lightweight"). Glass CSS adds a subtle noise texture layer to match Windows acrylic's recipe. Confidence H · Reversibility easy · [default]
4. **LOCKED: Free-floating loose items, like the real desktop** — faithful to Fences/Windows; no forced "Unsorted" group. Rejected: everything-in-a-group. Confidence H · Reversibility easy · [user]
5. **LOCKED: Theme follows the Windows app theme via `nativeTheme.shouldUseDarkColors`, with a manual override (System / Dark / Light)** — dark = Flux tokens from `designInpo.html`, light = Neo-Tactile frosted tokens from `taskbarDesign.jpg`. Rejected: fixed dark default, fixed light default. Confidence H · Reversibility easy · [user]
6. **LOCKED: To-do panel is a floating glass widget sharing the group chrome (move, resize, roll-up, quick-hide)** — one interaction model, one set of tests. Rejected: docked edge panel. Confidence H · Reversibility easy · [user]
   **Extension (2026-09-23, user):** the widget hosts a side tool rail with two tools, Tasks and a countdown Timer (start, pause, resume, stop). Rejected: a separate timer widget (a second floating window to manage), a timer inside the settings inspector (not on the desktop). The rail-in-widget reading of "the same section where the tools are on the side" is `(assumed — not in brief)`.
7. **LOCKED: Layout keys are NTFS file ids (`fs.stat(path,{bigint:true}).ino` as a decimal string) with the last known path stored beside them; files never move except on explicit Explorer drop, rename or trash; `moveToDesktop` writes an `ops.json` journal entry before touching disk and replays it on boot** — because file ids survive renames and case changes (Explorer's and ours), which closes the crash-between-rename-and-save gap, and the journal closes it for cross-volume moves where the id changes. Rejected: lowercase-path keys (`toLowerCase` ≠ NTFS upcase; renames orphan placements; crash ordering), per-group subfolders (breaks shortcuts). Path comparisons that remain use `toUpperCase()` per NTFS convention. Confidence H · Reversibility hard · [default]
8. **LOCKED: DnD = `@dnd-kit/core` + `@dnd-kit/sortable` 6.x with `PointerSensor { distance: 6 }`; resize/drag handles call `stopPropagation` on `pointerdown` so the sensor ignores them; external drops use native `drop` + `webUtils.getPathForFile`; drag-out cancels the dnd-kit drag before `webContents.startDrag`** — widest-known API, cross-container moves, multi-item overlay, sortable to-dos; pointer-based DnD does not collide with native file drops. Rejected: Pragmatic DnD (feature claims unverified; native ghost images), react-rnd (#622/#917). Confidence M · Reversibility medium · [default]
9. **LOCKED: State = zustand 5 stores in the renderer, persisted through IPC to zod-validated versioned JSON with debounced atomic writes (`write-file-atomic`)** — schema `version` + migration table is the cheapest durable format. Rejected: SQLite, electron-store. Confidence H · Reversibility easy · [default]
10. **LOCKED: Tests = vitest (node env for main, jsdom for renderer with pointer-capture polyfills and `user-event` v14 pointer API) + Playwright `_electron` for interactive Windows runs; Win32/COM sits behind `Win32Api` with a fake so every unit test runs headless** — Confidence H · [default]
11. **LOCKED: UI stack = React 19, TypeScript strict, Vite via electron-vite 5, Tailwind v4, shadcn/ui (ContextMenu, DropdownMenu, Dialog, Switch, Slider, Input, Button, Tooltip, Checkbox), `@fontsource-variable/inter` with `"Segoe UI Variable Text"` first in the stack** — team defaults. [default]
12. **LOCKED: `.lnk` resolution = pure-TypeScript MS-SHLLINK parser (LinkInfo `LocalBasePath`/`CommonPathSuffix`, `IconLocation`, `RelativePath`) as primary; `shell.readShortcutLink` only as fallback for non-UNC targets** — because `readShortcutLink` is synchronous on the main thread and can block for seconds on a dead UNC target. Spec: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/. Rejected: worker thread (Electron `shell` is unavailable there). Confidence M · Reversibility easy · [default]

## Setup & commands

```
git init && git checkout -b taskyard            # greenfield
npm create @quick-start/electron@latest . -- --template react-ts   # electron-vite 5 scaffold
npm i react@19 react-dom@19 zustand@5 zod@4 @dnd-kit/core@6 @dnd-kit/sortable@6 @dnd-kit/utilities koffi@3 chokidar@4 write-file-atomic@8 electron-log@5 @fontsource-variable/inter lucide-react class-variance-authority clsx tailwind-merge
npm i -D electron@44 electron-vite@5 electron-builder@26 typescript@5 tailwindcss@4 @tailwindcss/vite vitest@3 jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom vitest-axe @playwright/test@1.63 playwright@1.63 eslint @vitejs/plugin-react tsx
npx shadcn@latest init            # style: new-york, base color: neutral, css variables: yes
```

Env var names (never values): `TASKYARD_DESKTOP_DIRS` (semicolon list overriding the scanned folders, used by tests), `TASKYARD_USER_DATA` (overrides `app.getPath('userData')`), `TASKYARD_NO_WIN32` (`1` = use the Win32 fake), `TASKYARD_LOG_LEVEL`.

Scripts (package.json): `dev` (`electron-vite dev`), `build`, `typecheck` (`tsc -p tsconfig.node.json && tsc -p tsconfig.web.json`), `lint`, `test` (`vitest run` — headless, runs anywhere), `test:watch`, `test:e2e:win` (`playwright test` — needs an interactive Windows session), `verify:zorder` (`tsx scripts/verify-zorder.ts` — interactive Windows), `verify:koffi` (`tsx scripts/verify-koffi.ts` — launches the packaged exe and asserts `koffi.load('user32.dll')` succeeded), `dist` (`electron-vite build && electron-builder --win nsis`).

Rollback = one commit per phase on branch `taskyard`.

## Risks & failure modes

| Failure mode | Impact | Mitigation | Designed? |
|---|---|---|---|
| Win+D raises the shell desktop above Taskyard | Desktop shows raw Explorer icons | Foreground WinEvent hook + 500 ms poll re-seat above shell window; `verify:zorder` asserts `isAbove(taskyard, shellWindow)` after `ToggleDesktop()` | Phase 2 |
| koffi subclass callback misbehaves inside Electron's loop | Window pops to front on click | try/catch → `DefSubclassProc`; `RemoveWindowSubclass` on `close`; event fallback (`focus`/`show`/`restore` → re-seat) | Phase 2 |
| koffi prebuilt incompatible with Electron 44 ABI | App crashes on launch | `verify:koffi` against the packaged exe in Phase 1, before any Win32 work | Phase 1 |
| Full-monitor foreground window trips shell fullscreen heuristic | Auto-hide taskbar stops appearing | 1 px bottom inset; verified with auto-hide taskbar in `verify:zorder` manual step | Phase 2 |
| Wallpaper copy stale (slideshow, Spotlight, per-monitor change) | Wrong wallpaper | `WM_SETTINGCHANGE` hook + chokidar on Themes folder + 60 s `IDesktopWallpaper` poll | Phase 6 |
| HDR `.jxr` wallpaper undecodable | Solid colour instead of picture | Fall back to `Transcoded_00N` JPEG cache, then colour; settings hint | Phase 6 |
| Layout file corrupt / schema mismatch | Groups lost | zod → migrate → rename `layout.corrupt-<ts>.json`, restore `.bak`, toast | Phase 3 |
| Crash between disk move and layout save | Placement points at a vanished path | File-id keys (rename-safe) + `ops.json` journal replay for moves | Phase 3, 4 |
| File deleted/renamed in Explorer or while Taskyard is closed | Dangling placement | `reconcile` hides missing ids, stamps `lastSeen`, prunes after 30 days; renames keep the id | Phase 7 |
| Cross-volume move deletes source after partial copy | Data loss | Copy → SHA-256 compare → delete; on mismatch keep source, report | Phase 4 |
| OneDrive Known-Folder-Move Desktop with Files-On-Demand | Icon extraction hydrates hundreds of files | `GetFileAttributesW` flags `RECALL_ON_DATA_ACCESS`/`OFFLINE` → generic icon, never opened; hydration storms debounced | Phase 4, 5 |
| Public Desktop read-only for standard users | Rename/trash throw `EPERM` | `fs.access(W_OK)` per folder → `readonly` flag → actions disabled + tooltip | Phase 4 |
| Dead UNC shortcut target blocks main thread | UI freeze | TS `.lnk` parser; UNC targets never touched for icons | Phase 4 |
| Icon alpha wrong (straight vs premultiplied; zero-alpha legacy icons) | Fringes / invisible icons | Premultiply BGRA; if alpha all zero derive from `hbmMask` | Phase 5 |
| 200+ items × icon extraction slow at startup | Blank tiles for seconds | Disk cache keyed by `fileId+mtime+size`; 32 px first, 64 px streamed; concurrency 4 | Phase 5 |
| Many blurred groups drop frames | Drag jank | `contain: paint`, blur ≤ 20 px, blur paused on the moving group, reduced-transparency honoured; measured during Peek | Phase 6, 12 |
| Display removed/added/DPI change; two identical monitors | Groups off-screen or on the wrong monitor | `display-metrics-changed` → re-clamp; match by id → bounds (size **and** position) → primary | Phase 11 |
| `webContents.startDrag` modal loop while dnd-kit drag active | Stuck overlay | Cancel dnd-kit first, snapshot selection, then IPC | Phase 8 |
| koffi native binary missing in packaged app | Crash on launch | `asarUnpack` for `koffi/**` and `@koromix/**`; `verify:koffi` | Phase 1 |

Most likely to go wrong: keeping the window seated above the shell window through Win+D / Explorer restart (Phase 2). Most catastrophic: a cross-volume move or rename that loses a file (Phase 4 hash-verify + journal). Most underestimated: Phase 4 (attributes, OneDrive placeholders, ACLs, long paths and `.lnk` parsing are five separate Win32 problems), so it is split from the icon pipeline (Phase 5).

## Innovations

CORE (all land in phases): true-glass over live wallpaper (6) · marquee "draw a group" like Fences (7) · multi-select drag with stacked preview (8) · Explorer drop with Undo (8) · Peek shortcut (9) · first-run Auto-organize by type (11) · rename-proof placement via file ids (3, 4).
CUT (brief says "simple"): Folder Portals, automation rules, Desktop Pages, layout snapshots, cross-monitor drag, cloud sync.

## Phases

### Phase 1 — Scaffold & toolchain   (Size: M)
**Goal:** A typed Electron + React app that builds, lints, tests and packages, with koffi proven to load inside the packaged exe.
**Depends on:** none.
**Touches:** `package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `tsconfig.node.json`, `tsconfig.web.json`, `vitest.config.ts` (workspace: `main` env node, `renderer` env jsdom), `src/renderer/test/setupTests.ts` (jest-dom; polyfills for `Element.prototype.setPointerCapture/releasePointerCapture/hasPointerCapture`; `PointerEvent` shim when missing), `src/renderer/test/dnd-rects.ts` (per-element `getBoundingClientRect` mock helper), `playwright.config.ts`, `components.json`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/main.tsx`, `src/renderer/App.tsx`, `src/renderer/styles/index.css` (`@import "tailwindcss"`), `src/main/app/logger.ts` (electron-log, `userData/logs`, 1 MB × 3), `scripts/verify-koffi.ts`, `.gitignore` (`node_modules`, `out`, `dist`, `STUDY_GUIDE.md`), `STUDY_GUIDE.md`.
**Requirements**
- [ ] `npm run dev` opens a placeholder window; `typecheck`, `lint`, `test`, `build` all exit 0.
- [ ] `electron-builder.yml`: `appId: com.taskyard.app`, `win.target: nsis`, `asarUnpack: ["node_modules/koffi/**","node_modules/@koromix/**"]`, `requestedExecutionLevel: asInvoker`.
- [ ] `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`webUtils` is available to sandboxed preloads).
- [ ] Single-instance lock in `src/main/index.ts`; a second launch exits after signalling the first (`second-instance` → Peek, wired in Phase 9).
- [ ] Main process loads `user32.dll` through koffi at startup and logs the result; `verify:koffi` launches `dist/win-unpacked/Taskyard.exe` and reads that log line.
**Tests** — `src/main/app/logger.test.ts` (writes to the injected dir, rotates at 1 MB); `e2e/smoke.spec.ts` (Playwright `_electron.launch`, one window, title "Taskyard").
**Acceptance** — `npm run typecheck && npm run lint && npm test` green anywhere; on Windows `npm run test:e2e:win` green and `npm run dist && npm run verify:koffi` prints `koffi: user32 loaded (packaged)`.

### Phase 2 — Desktop-layer window spike (riskiest unknown)   (Size: L)
**Goal:** Prove an opaque, frameless, per-display window stays seated directly above the shell desktop window through clicks, Win+D, Explorer restarts and sleep/resume; is absent from Alt-Tab/taskbar; and can be raised for Peek.
**Depends on:** 1.
**Touches:** `src/main/win32/api.ts` (interface `Win32Api`: `seatAboveShell(hwnd)`, `setTopmost(hwnd, on)`, `showNoActivate(hwnd)`, `installZOrderGuard(hwnd, mode: () => 'bottom'|'peek')`, `removeZOrderGuard(hwnd)`, `watchForeground(cb)`, `getShellWindow()`, `isAbove(hwndA, hwndB)`, `getFileAttributes(path)`, `regGetString(hive, key, value)`, `getWallpaperForMonitor(rectPx)` — declared here with a fake; implemented in Phase 6 `wallpaper.ts` via `com.ts`, `extractIcon(file, index, px)`), `src/main/win32/koffi-api.ts` (user32: `SetWindowPos`, `ShowWindow`, `GetWindow`, `GetShellWindow`, `FindWindowExW`, `EnumWindows`, `SetWinEventHook`, `UnhookWinEvent`, `SystemParametersInfoW`; comctl32: `SetWindowSubclass`, `RemoveWindowSubclass`, `DefSubclassProc`; advapi32: `RegGetValueW`; kernel32: `GetFileAttributesW`; `WINDOWPOS` via `koffi.struct`; all paths passed as `\\?\`-prefixed UTF-16), `src/main/win32/shell-window.ts` (finds Progman or the WorkerW that hosts `SHELLDLL_DefView`, re-resolved on every re-seat since Explorer restarts create new handles), `src/main/win32/fake-api.ts`, `src/main/win32/index.ts` (fake when `TASKYARD_NO_WIN32=1` or not win32), `src/main/windows/desktop-window.ts` (`frame:false, transparent:false, backgroundColor:'#000000', roundedCorners:false, skipTaskbar:true, resizable:false, movable:false, minimizable:false, maximizable:false, fullscreenable:false, hasShadow:false, type:'toolbar', show:false, focusable:true`; `webPreferences.backgroundThrottling:false` (the window is occluded most of the time and must still stream icons and animate Peek); loads `index.html?displayId=<id>` and passes `additionalArguments:['--display-id=<id>']`; bounds = `display.bounds` with `height - 1`), `src/main/windows/desktop-window-manager.ts` (one window per display; `peeking` boolean is the **single source of truth** for Peek, read by the guard's `mode` callback and broadcast as `peek:changed`; `peek(on, {hold?: 'inspector'})` — a hold suppresses the idle auto-unpeek until released; reacts to `display-added/removed/metrics-changed` and emits `display:changed`; `reseatAll()`), IPC `display:get(id) → {id, bounds, workArea, scaleFactor}`, `display:list`, `scripts/verify-zorder.ts`.
**Requirements**
- [ ] After `ready-to-show`: `showNoActivate` → `seatAboveShell` → `installZOrderGuard`. Guard = subclass proc rewriting `WINDOWPOS.hwndInsertAfter` (bottom: the window just above the shell window; peek: `HWND_TOPMOST`) unless `SWP_NOZORDER` is set; wrapped in try/catch returning `DefSubclassProc`; removed in `win.on('close')`.
- [ ] Each renderer can read its own `displayId` from the URL and fetch `display:get` for bounds/workArea/scaleFactor; `display:changed` re-delivers them.
- [ ] Sentinel: `watchForeground` (`EVENT_SYSTEM_FOREGROUND`, `WINEVENT_OUTOFCONTEXT`) and a 500 ms poll call `reseatAll()` whenever `isAbove(shellWindow, ourHwnd)`.
- [ ] Event fallback always installed: `focus`/`show`/`restore`/`powerMonitor.resume` → `seatAboveShell`.
- [ ] Window is excluded from Alt-Tab and the taskbar; clicking inside gives keyboard focus without raising it above other apps.
- [ ] `peek(true)` raises all desktop windows topmost; `peek(false)` re-seats them.
- [ ] Explorer restart leaves the window visible and correctly seated within 2 s.
- [ ] With the taskbar set to auto-hide, the taskbar still slides up while Taskyard is foreground (manual step in `verify:zorder` output).
**Tests** — `fake-api.test.ts` (records calls); `shell-window.test.ts` (picks WorkerW hosting DefView from a fake window tree; falls back to Progman); `desktop-window-manager.test.ts` (windows per display; URL carries `displayId`; `display:get` returns scaleFactor; `seatAboveShell` after show; peek toggles topmost and emits `peek:changed`; a held peek ignores the idle timer; `reseatAll` on foreground event) with mocked `electron`; `scripts/verify-zorder.ts` automated acceptance: launch app → `start notepad` → assert `isAbove(notepad, taskyard) && isAbove(taskyard, shellWindow)` → PowerShell `(New-Object -ComObject Shell.Application).ToggleDesktop()` → wait 800 ms → assert `IsWindowVisible && !IsIconic && isAbove(taskyard, shellWindow)` → toggle back → `SetForegroundWindow(taskyard)` → assert still below Notepad → `taskkill explorer && start explorer` → wait 2 s → assert seated above the new shell window.
**Acceptance** — `npm run verify:zorder` prints `PASS` for all five checks on Windows 11 25H2; `npm test` green with the fake.

### Phase 3 — Shared schema, storage, IPC bridge   (Size: M)
**Goal:** Versioned, validated, atomically persisted state reachable from the renderer through a typed bridge, with a move journal.
**Depends on:** 1.
**Touches:** `src/shared/schema.ts` (zod: `DesktopItem {id /*file id = `${dev}:${ino}` from fs.stat bigint, regex ^\d+:\d+$*/, path, name, ext, kind:'app'|'file'|'folder'|'link'|'url', mtimeMs, sizeBytes, readonly, placeholder, targetPath?, url?}`, `Group {id, title, x, y, w, h, z, rolledUp, items: string[] /*file ids*/, sort:'manual'|'name'|'type'|'modified', excludeFromQuickHide, createdAt}`, `DisplayLayout {displayId, bounds:{x,y,width,height}, groups, loose: Record<string,{x,y}>, tools:{x,y,w,h,rolledUp,visible,activeTool:'tasks'|'timer'}}`, `LayoutFile {version:1, displays: DisplayLayout[], paths: Record<string,string> /*id → last path, top-level so a rename updates one place*/, lastSeen: Record<string, number> /*id → epoch ms when first missing*/}`, `Task {id, text, done, order, createdAt, completedAt?}`, `TimerState {status:'idle'|'running'|'paused'|'finished', durationMs, endsAt?, remainingMs?, linkedTaskId?, presetsMs:[300000,900000,1500000,2700000]}`, `TasksFile {version:1, tasks, timer: TimerState}`, `SettingsFile {version:1, theme:'system'|'dark'|'light', glassOpacity 0–100 (40), glassBlur 0–40 (16), glow, accent:'cyan'|'blue'|'purple'|'white', iconSize:'small'|'medium'|'large', showExtensions, quickHideOnDoubleClick, peekShortcut:'Ctrl+Alt+Space', autostart, toolsEnabled, timerSound, timerNotify, gridSnap, firstRunDone}`, `OpsJournal {version:1, ops: MoveOp[]}` with `MoveOp {token, from, to, state:'pending'|'copied'|'done'|'undone'}`), `src/shared/ipc.ts` (request channels per phase plus the full event list: `desktop:changed`, `desktop:renamed`, `desktop:icon`, `storage:recovered`, `theme:changed`, `peek:changed`, `display:changed`, `wallpaper:changed`; app channels `app:quit`, `app:openExternal(url)` with an allow-list of `ms-settings:` and `https:` prefixes), `src/main/storage/json-store.ts` (`JsonStore<T>`: load → parse → migrate → validate; `save` debounced 300 ms via `write-file-atomic`, keeps `<file>.bak`; `flush()`), `src/main/storage/migrations.ts`, `src/main/storage/stores.ts`, `src/main/storage/ops-journal.ts` (append-before-act, `replay()` on boot: `pending` → nothing to undo; `copied` → verify hash then finish or roll back), `src/main/ipc/handlers.ts` (zod-validated inbound), `src/preload/index.ts` (`contextBridge.exposeInMainWorld('taskyard', api)`; `taskyard.on(event, cb)` returns an unsubscribe; no `clipboard` in a sandboxed preload — "Copy path" uses `navigator.clipboard.writeText`), `src/preload/api.d.ts`, `src/renderer/stores/settings.ts`, `layout.ts`, `tasks.ts`, `items.ts` (`DesktopItem[]` by id: `hydrate(list)`, `applyChange({added, removed, changed})`, `applyRenamed(id, path)`, `setIcon(id, px, dataUrl)`; subscribed to the desktop events in `App.tsx`; wired to the layout store in Phase 4/7), `ui.ts` (toasts queue), `src/renderer/components/feedback/Toaster.tsx`.
**Requirements**
- [ ] Corrupt or invalid file → renamed `*.corrupt-<iso>.json`, `.bak` restored if valid, else defaults; renderer receives `storage:recovered` and shows a toast.
- [ ] Unknown future `version` → read-only mode with a persistent banner; never overwritten.
- [ ] `flush()` is awaited in `before-quit`; a change 100 ms before quit is on disk.
- [ ] `ops.json` is written synchronously before any disk move begins and updated after each step. Boot order in `src/main/index.ts`: stores load → `opsJournal.replay()` → windows → scan → watcher. A rolled-back op emits `desktop:changed {removed:[toIds]}` so no phantom placement survives.
**Tests** — `json-store.test.ts`: round-trip · corrupt recovers from `.bak` · 10 writes coalesce · `flush` writes pending; `migrations.test.ts`: v0 → v1; `schema.test.ts`: rejects negative size, rejects id not matching `^\d+:\d+$`; `ops-journal.test.ts`: replay finishes a `copied` op with matching hash, rolls back on mismatch and reports removed ids, replay runs before scan (order spy); `stores/layout.test.ts`: `addGroup` persists via mocked bridge; `stores/items.test.ts`: hydrate/applyChange/applyRenamed/setIcon; `Toaster.test.tsx`: shows and auto-dismisses.
**Acceptance** — `npm test -- storage schema stores ops toaster` green.

### Phase 4 — Desktop scanner, attributes, shortcuts, watcher, file ops   (Size: L)
**Goal:** The main process knows every desktop item, its kind, attributes and target, keeps that current as files change, and performs open/rename/trash/move safely.
**Depends on:** 2, 3.
**Touches:** `src/main/desktop/scanner.ts` (folders: `app.getPath('desktop')` + `C:\Users\Public\Desktop`, or `TASKYARD_DESKTOP_DIRS`; per folder `fs.access(W_OK)` → `readonly`; per item `fs.stat({bigint:true})` → `id = \`${dev}:${ino}\`` (volume serial + file index, so a redirected Desktop on another volume cannot collide); `win32.getFileAttributes` → skip `HIDDEN|SYSTEM`, flag `placeholder` when `RECALL_ON_DATA_ACCESS (0x400000)` or `OFFLINE (0x1000)`), `src/main/desktop/lnk-parser.ts` (MS-SHLLINK: header, `LinkInfo` → `LocalBasePath`+`CommonPathSuffix` or `CommonNetworkRelativeLink`, StringData `RelativePath`/`IconLocation`, `IconIndex`; env-var expansion for `%SystemRoot%`), `src/main/desktop/shortcuts.ts` (`.lnk` → parser, fallback `shell.readShortcutLink` only for local targets; `.url` → INI `URL=`, `IconFile=`, `IconIndex=`), `src/main/desktop/classify.ts`, `src/main/desktop/watcher.ts` (chokidar 4, `awaitWriteFinish`; keeps a `path → id` map from the last scan because an unlinked path can no longer be stat'ed; an `add` whose id matches an `unlink` from the last 500 ms = rename → `desktop:renamed {id, path}`; storms debounced 150 ms), IPC `desktop:rescan` (tray/canvas "Refresh desktop"), `src/main/desktop/file-ops.ts` (`open(id)`: `.url` → `shell.openExternal`, else `shell.openPath`; `showInFolder`; `rename(id, newName)` refuses when `readonly`, maps `EEXIST`/`EPERM`/`ENAMETOOLONG` to typed errors; `trash(id)` via `shell.trashItem`; `moveToDesktop(paths[])`: journal → same-volume `fs.rename` else copy → SHA-256 compare → delete; `undoMove(token)`), IPC `desktop:list`, `desktop:open`, `desktop:showInFolder`, `desktop:rename`, `desktop:trash`, `desktop:moveToDesktop`, `desktop:undoMove`, `desktop:rescan`; events `desktop:changed`, `desktop:renamed`. Renderer wiring in `src/renderer/stores/items.ts`: `applyChange` → `layout.reconcile(presentIds)` (Phase 7), `applyRenamed` → `layout.onRenamed(id, path)`.
**Requirements**
- [ ] Initial scan of 200 items (150 `.lnk`) completes ≤ 300 ms excluding icons, measured by `scanner.bench.test.ts` on the fixture.
- [ ] Renames (ours or Explorer's) keep the item's group/loose placement because the id is unchanged; the layout's top-level `paths[id]` is updated once.
- [ ] Placeholder items are never opened for reading by Taskyard until Windows clears the attribute.
- [ ] Rename/Delete are disabled (with tooltip) for `readonly` items; `EPERM` at runtime becomes a toast, never a crash.
- [ ] A `.lnk` with a UNC or unreachable target resolves without touching the target.
**Tests** — `scanner.test.ts` (skips hidden/system via fake attributes; flags placeholder and readonly; id is `dev:ino`); `lnk-parser.test.ts` (fixtures: local `.lnk` with LocalBasePath, UNC `.lnk`, `.lnk` with env-var path, `.lnk` with IconLocation + index, truncated file → error); `shortcuts.test.ts` (`.url` INI; parser failure → fallback only for local); `watcher.test.ts` (unlink+add same id via the path→id map → renamed event; add/remove debounced; `desktop:rescan` re-emits a full list); `file-ops.test.ts` (rename swaps path keeps id; `EEXIST` typed; readonly refused; cross-volume copy verifies hash, deletes only on match; undo restores; journal states advance); `scanner.bench.test.ts`.
**Acceptance** — `npm test -- desktop` green; `npm run dev` logs `scan: N items in <ms> (R readonly, P placeholders)` for the real desktop.

### Phase 5 — Icon pipeline   (Size: M)
**Goal:** Every item has a crisp icon, cached, without hydrating placeholders or blocking on remote targets.
**Depends on:** 4.
**Touches:** `src/main/desktop/icon-service.ts` (LRU + disk cache `userData/icons/<sha1(id|mtime|size)>@<px>.png`; step 1 `app.getFileIcon(path,{size:'normal'})` for local non-placeholder items; step 2 `win32.extractIcon(iconFile ?? target, index, px)` with `px = ceil(64 × max(display.scaleFactor over all displays))` (the icon service is main-side and display-agnostic; px is part of the cache key; on `display:changed` with a larger max scale, affected icons are re-extracted) for kinds `app` and shortcuts whose target is local `.exe/.ico/.dll`; placeholders and UNC targets → built-in generic icon by kind; concurrency 4; failures → generic; results streamed as `desktop:icon {id, px, dataUrl}`), `src/main/win32/koffi-api.ts` (+ `PrivateExtractIconsW`, `GetIconInfo`, `GetDIBits` (32-bpp top-down BITMAPINFO), `DestroyIcon`, `DeleteObject`), `src/main/win32/icon-bitmap.ts` (BGRA → premultiplied; all-zero alpha → alpha from `hbmMask`; → `nativeImage.createFromBitmap` → PNG), `src/renderer/assets/generic-icons/*.svg`.
**Requirements**
- [ ] Warm cache: all 200 fixture icons resolve from disk in ≤ 200 ms total (`icon-service.bench.test.ts`).
- [ ] 64 px icons are sharp at 150 % DPI (tile 48 CSS px ⇒ 72 physical px, request 96 px).
- [ ] Extraction never runs for placeholders or UNC targets.
**Tests** — `icon-service.test.ts` (cache hit skips extraction; px follows max scaleFactor and re-extracts when it grows; placeholder → generic without any fs read; failure → generic); `icon-bitmap.test.ts` (premultiplication of a known pixel; zero-alpha icon gets mask-derived alpha; size round-trip); `icon-service.bench.test.ts`.
**Acceptance** — `npm test -- icon` green; every `.lnk` on the real desktop shows its target's icon in `npm run dev`.

### Phase 6 — Wallpaper layer, theme tokens, glass system   (Size: L)
**Goal:** Each display window shows that monitor's wallpaper exactly as Windows does, and the glass/theme token system renders both variants and follows the Windows theme.
**Depends on:** 2, 3.
**Touches:** `src/main/win32/com.ts` (koffi COM helper: `CoInitializeEx`, `CoCreateInstance`, vtable call by index via `koffi.decode` + `koffi.proto`), `src/main/win32/wallpaper.ts` (`IDesktopWallpaper`: `GetMonitorDevicePathCount/At`, `GetMonitorRECT`, `GetWallpaper(monitorId)`, `GetPosition`; match monitor RECT (physical px) to Electron display bounds × `scaleFactor`; fallback `SPI_GETDESKWALLPAPER` + registry `WallpaperStyle`/`TileWallpaper`; solid colour from `HKCU\Control Panel\Colors\Background`; content-sniff JPEG/PNG/BMP/GIF/WebP; undecodable (`.jxr`/HDR) → `%APPDATA%\Microsoft\Windows\Themes\Transcoded_00N` for that monitor index → colour), `src/main/desktop/wallpaper-service.ts` (`protocol.handle('taskyard', …)` serving `taskyard://wallpaper/<displayId>?v=<n>`; bumps `v` on `WM_SETTINGCHANGE` (`hookWindowMessage(0x001A)`), chokidar on the Themes folder, 60 s poll), `src/shared/wallpaper-geometry.ts` (pure: image size + position + display bounds + virtual-screen bounds → CSS `background-size/position/repeat` for fill/fit/stretch/center/tile/span), `src/renderer/components/canvas/WallpaperLayer.tsx`, `src/renderer/styles/tokens.css` (dark: `--bg #000`, `--deep-blue #001233`, `--accent-1 #00f2ff`, `--accent-2 #0077ff`, `--glass-bg rgba(0,15,40,.4)`, `--glass-border rgba(0,242,255,.15)`, `--glow 0 8px 32px rgba(0,119,255,.2)`, text 100/70/50 %; light: `--glass-bg rgba(255,255,255,.62)`, `--glass-border rgba(255,255,255,.45)`, `--accent-1 #3b6ef5`, `--accent-2 #00d5e6`, text `#0b1220` at 100/70/50 %; shared radii 12/18/32/40, spacing 12/16/24/32/40, type 10/11/12/13/14; `--blur` and `--glass-opacity` from settings), `src/renderer/styles/glass.css` (`.glass`: bg + `backdrop-filter: blur(var(--blur)) saturate(1.2)` + 1 px border + inner highlight + `contain: paint`; `@media (prefers-reduced-transparency: reduce)` and `[data-reduced-transparency]` → opacity .92, no blur; `[data-dragging] .glass` → no blur), `src/renderer/styles/motion-variables.css` (**copied verbatim** from `C:\Users\doa92\.claude\design-patterns\scroll-choreography\code\motion-variables.css` after reading `00-architecture.md`), `src/renderer/lib/theme.ts` (`data-theme` from settings + `nativeTheme` `theme:changed`; `nativeTheme.prefersReducedTransparency` → `data-reduced-transparency`), Inter via `@fontsource-variable/inter`; font stack `"Segoe UI Variable Text","Segoe UI Variable","Inter Variable","Segoe UI",sans-serif`.
**Requirements**
- [ ] Changing the wallpaper (any monitor, slideshow advance, Spotlight rotation) updates the affected window within 2 s.
- [ ] No wallpaper → solid colour; undecodable → transcoded cache → colour, each with one log line and a settings hint.
- [ ] Theme `system` flips live with the Windows app theme; `dark`/`light` override wins.
- [ ] Quick-hide reveals the plain wallpaper layer (no transparency needed).
**Tests** — `wallpaper-geometry.test.ts` (fill crops, fit letterboxes, span offsets by display origin, tile repeats, center no-scale, stretch); `wallpaper.test.ts` (monitor RECT → display match at 150 % DPI; empty path → colour; JPEG sniff; `.jxr` → transcoded fallback); `com.test.ts` (vtable index call against a fake); `theme.test.ts` (system→dark, override wins, reduced-transparency attribute); `WallpaperLayer.test.tsx` (re-requests `?v=2` after a change event).
**Acceptance** — `npm test -- wallpaper theme com` green; on the dev machine each monitor's Taskyard wallpaper matches its real wallpaper at the display's fit mode (manual check recorded in the phase commit message).

### Phase 7 — Groups, loose icons, selection, marquee   (Size: L)
**Goal:** Create, rename, move, resize, roll-up, reorder (z) and delete groups; render loose icons on a grid; select with click/ctrl/shift/marquee; reconcile placements with what is on disk.
**Depends on:** 3, 4, 5, 6.
**Touches:** `src/shared/geometry.ts` (`clampRect`, `snapRect(grid 8)`, `rectsIntersect`, `firstFreeSlot(occupied, cell, area)`, `hitTest`), `src/renderer/components/canvas/DesktopCanvas.tsx` (per-display root: wallpaper, loose layer, groups by `z`, marquee, context menu, double-click quick-hide), `LooseIconLayer.tsx`, `Marquee.tsx`, `CanvasContextMenu.tsx` (New group here · Auto-organize… · Sort loose icons · Show/Hide tools widget · Refresh · Settings · Display settings (`ms-settings:display`) · Personalize (`ms-settings:personalization-background`) · Quit), `src/renderer/components/group/GroupWindow.tsx` (`role="region"`, `aria-label`, `.glass`), `GroupHeader.tsx`, `GroupBody.tsx` (CSS grid; cell 64/80/96 by `iconSize`), `ResizeHandles.tsx` (8 handles, `setPointerCapture`, `pointerdown` `stopPropagation`, min 160×120, clamp to work area, snap when `gridSnap`), `useGroupDrag.ts` (title-bar drag, `stopPropagation`, clamp, bring-to-front), `GroupContextMenu.tsx` (Rename · Roll up/down · Sort by · Icon size · Exclude from quick-hide · Move to display ▸ · Delete group), `src/renderer/components/icon/DesktopIcon.tsx` (`role="option"`, `aria-selected`, label ellipsis, extension toggle, `readonly`/`placeholder` badges), `RenameInline.tsx` (Enter commits, Esc cancels, empty reverts, max 255, invalid chars `<>:"/\|?*` blocked, disabled when readonly), `src/renderer/components/feedback/ConfirmDialog.tsx`, `src/renderer/stores/ui.ts` (selection, marquee, quickHidden, inspectorOpen), `src/renderer/stores/layout.ts` (`createGroup(rect, ids?)`, `renameGroup`, `moveGroup`, `resizeGroup`, `toggleRollUp`, `bringToFront`, `deleteGroup` → items become loose near the old rect, `moveGroupToDisplay(groupId, displayId)` clamped into the target work area from `display:list`, `setLoosePosition`, `placeNewItems(ids)` on the **primary** display via `firstFreeSlot`, `onRenamed(id, path)` updates `paths[id]`, `reconcile(presentIds)`: runs on hydrate and on every `applyChange`; a placed id that is missing gets `lastSeen[id] = now` (if unset) and is not rendered; a present id clears `lastSeen`; ids missing > 30 days are removed from `groups[].items`, `loose`, `paths`; unplaced present ids go to `placeNewItems`).
**Requirements**
- [ ] New group via context menu appears at the click point (280×200) with inline rename focused; via marquee it takes the marquee bounds and captures loose icons inside.
- [ ] Double-click title = roll-up; rolled group shows only the 36 px header and keeps its width.
- [ ] Group edges never leave the work area (`display.workArea`, soft clamp re-applied on `display-metrics-changed`); resizing below min stops at min.
- [ ] Deleting a group never deletes files; confirm shows the item count.
- [ ] Keyboard: arrows move selection inside a group, `Enter` opens, `F2` renames, `Delete` trashes (confirm), `Esc` clears, `Ctrl+A` selects all in the focused group; visible focus ring.
- [ ] Empty group shows "Drop icons here"; empty desktop shows a hint card with "Auto-organize".
- [ ] Files added or removed while Taskyard was closed are placed or hidden on the first reconcile after launch.
**Tests** — `geometry.test.ts` (clamp, snap, free-slot column-first, skips occupied); `layout.test.ts` (reconcile hides a missing id and stamps `lastSeen`; clears it when the id returns; prunes after 30 days; places new ids on the primary display; `moveGroupToDisplay` clamps; `onRenamed` updates one path entry); `ConfirmDialog.test.tsx`; `GroupWindow.test.tsx` (title; roll-up hides body; resize via `user-event` pointer sequence updates size; min enforced; handle `pointerdown` does not reach the DnD sensor); `RenameInline.test.tsx` (commit/cancel/empty/invalid/readonly); `Marquee.test.tsx` (creates group with contained icons); `DesktopIcon.test.tsx` (ellipsis, extension toggle, `aria-selected`, badges); `keyboard.test.tsx`.
**Acceptance** — `npm test -- group icon canvas geometry` green; `e2e/groups.spec.ts`: create → rename → resize → roll-up → restart → persisted.

### Phase 8 — Drag and drop   (Size: L)
**Goal:** Move one or many items between groups and the loose layer with a live preview; accept Explorer drops; drag items out to other apps.
**Depends on:** 4, 7.
**Touches:** `src/renderer/components/dnd/DndProvider.tsx` (`DndContext`, `PointerSensor {activationConstraint:{distance:6}}`, `KeyboardSensor`, collision `pointerWithin` then `closestCenter`), `DragOverlayPreview.tsx` (stacked preview with count badge), `useItemDrop.ts` (group→group insert at index; group→canvas at snapped pointer position; canvas→group append; multi-item keeps relative order), `useExternalDrop.ts` (native `dragover/drop` on canvas + groups; `webUtils.getPathForFile`; paths already on the desktop are placed only; others `desktop:moveToDesktop` then placed; Undo toast → `desktop:undoMove` + un-place), `useDragOut.ts` (when a pointer drag leaves the window bounds: snapshot selection → `onDragCancel` → IPC `desktop:startDrag(ids)` → main `webContents.startDrag({files, icon})`), `GroupBody.tsx` (`useDroppable`, drop indicator), `LooseIconLayer.tsx` (`useDroppable`); toasts via the Phase 3 `Toaster`.
**Requirements**
- [ ] A click (< 6 px movement) never starts a drag; double-click opens.
- [ ] Drag between groups, to the canvas, and from canvas into a group; `manual` sort respects the drop index, other sorts re-sort after drop.
- [ ] Explorer drop of N files: moved to Desktop, placed at the drop point, Undo reverts moves and placements; read-only sources that cannot be moved are reported per file.
- [ ] Drag-out hands the files to the OS drag without leaving dnd-kit in a stuck state.
- [ ] Blur on the moving group is paused while dragging (`data-dragging`).
**Tests** — `useItemDrop.test.tsx` (index insert; multi keeps order; canvas drop snaps); `useExternalDrop.test.tsx` (desktop paths placed without move; others call `moveToDesktop`; undo restores); `DndProvider.test.tsx` (5 px → no dragStart, 8 px → dragStart) with `dnd-rects.ts`; `useDragOut.test.tsx` (cancels dnd-kit before IPC; overlay cleared); `DragOverlayPreview.test.tsx` (badge for 3 items).
**Acceptance** — `npm test -- dnd` green; `e2e/dnd.spec.ts` drags an item from group A to B and asserts membership after restart.

### Phase 9 — Item actions, quick-hide, Peek   (Size: M)
**Goal:** Everything you can do to an item, plus the two Fences-defining desktop gestures.
**Depends on:** 7.
**Touches:** `src/renderer/components/icon/IconContextMenu.tsx` (Open · Open file location · Rename · Copy path via `navigator.clipboard.writeText` · Remove from group · Delete; Rename/Delete disabled when readonly), `src/renderer/lib/keyboard.ts`, `src/renderer/stores/ui.ts` (+ `quickHidden`; `peeking` is a read-only mirror of `peek:changed` from main), `DesktopCanvas.tsx` (double-click empty → quick-hide toggle, 180 ms fade; excluded groups stay; canvas "Quit" → `app:quit`, settings links → `app:openExternal`), `src/main/app/shortcuts.ts` (`globalShortcut.register(settings.peekShortcut)` → `desktopWindowManager.peek(toggle)`; auto-unpeek on click outside a group/inspector or after 8 s idle, paused while any text input has focus or a hold such as `'inspector'` is active), `src/main/index.ts` (`second-instance` → Peek), tray "Peek".
**Requirements**
- [ ] Open works for `.lnk` (target), `.url` (browser), folders, files; `openPath` failure strings become toasts.
- [ ] Rename conflicts (`EEXIST`) show an inline error; `EPERM` a toast.
- [ ] Delete → Recycle Bin, confirm lists names (max 5 + "and N more").
- [ ] Quick-hide state is not persisted.
- [ ] Peek shortcut is rebindable and validated (`register` false → error shown).
**Tests** — `IconContextMenu.test.tsx` (bridge calls; remove-from-group makes item loose; disabled when readonly); `quick-hide.test.tsx`; `shortcuts.test.ts` (register/unregister on change; invalid accelerator reports; idle timer paused while input focused; an `'inspector'` hold suppresses idle unpeek until released); `file-ops.test.ts` (+ `.url` opens external).
**Acceptance** — `npm test -- icon shortcuts quick-hide` green; manual: `Ctrl+Alt+Space` shows groups over a maximized browser, click elsewhere returns them below.

### Phase 10 — Tools widget: to-do list and timer   (Size: L)
**Goal:** A floating glass widget with a side tool rail hosting two tools — a to-do list (add, edit, delete, reorder, complete) and a countdown timer (start, pause, resume, stop) — persisted like everything else.
**Depends on:** 7, 8.
**Touches:** `src/renderer/components/tools/ToolsWidget.tsx` (reuses `GroupHeader`, `ResizeHandles`, `useGroupDrag`; min 280×220; header title is the active tool's name; rolled-up header shows the remaining time while a timer runs), `ToolRail.tsx` (vertical glass pill on the widget's left edge, per the dark pill toolbar in `taskbarDesign.jpg`; `role="tablist"`, arrow keys switch, tabs "Tasks" and "Timer"; a glowing accent dot on the Timer tab while running), `todo/TodoTool.tsx` (`role="list"`), `todo/TodoInput.tsx` (Enter adds; single line; 500 chars), `todo/TodoItem.tsx` (checkbox `aria-checked`, inline edit on double-click/F2, delete ×, drag handle), `todo/TodoList.tsx` (`SortableContext` vertical; keyboard reorder `Alt+↑/↓`), `todo/CompletedSection.tsx` (collapsible, "Clear completed"), `timer/TimerTool.tsx` (large `mm:ss` display, `h:mm:ss` past an hour; accent progress ring like the cyan glow ring in the mockup; preset chips 5 / 15 / 25 / 45 min plus a custom minutes input 1–180; buttons Start · Pause/Resume · Stop; optional "Focus on…" picker linking an active task; `role="timer"` with `aria-live="off"` and a polite announcement at 1 minute and at 0), `timer/useTimerTick.ts` (250 ms interval computing remaining from an absolute `endsAt`, so it never drifts and survives sleep), `timer/chime.ts` (short WebAudio chime, gated by `timerSound`), `src/renderer/stores/tasks.ts` (`add`, `edit`, `remove`, `toggle`, `reorder`, `clearCompleted`), `src/renderer/stores/timer.ts` (`setDuration`, `start`, `pause`, `resume`, `stop`, `linkTask`, `acknowledge`; state `idle | running {endsAt} | paused {remainingMs} | finished`; hydrate recomputes from `endsAt` and enters `finished` with a "finished while you were away" note if it already passed), `stores/layout.ts` (`tools` rect + `activeTool` per display), `src/main/app/notifications.ts` (IPC `timer:notify` → Electron `Notification` "Timer finished" with the linked task name; tray tooltip shows remaining time while running), tray + canvas menu "Show tools widget", settings `toolsEnabled`, `timerSound`, `timerNotify`.
**Requirements**
- [ ] `toolsEnabled` off hides the widget everywhere and keeps tasks and timer state on disk.
- [ ] Completed tasks move to the collapsed section with strike-through; unchecking returns them to the bottom of active.
- [ ] Empty state "Nothing to do. Add a task above."; input keeps focus after add.
- [ ] Timer: Start begins the countdown from the chosen duration; Pause freezes it; Resume continues from the frozen value; Stop resets to the chosen duration. Presets and custom input are disabled while running.
- [ ] Timer completion: toast, Windows notification when `timerNotify`, chime when `timerSound`, ring pulses, and if a task is linked an inline "Mark done" action appears.
- [ ] A running timer survives an app restart (absolute `endsAt`); a timer that ended while the app was closed shows the finished state, not a negative count.
- [ ] Space toggles Start/Pause when the timer view has focus; Esc on a running timer asks before stopping.
- [ ] Widget moves/resizes/rolls up/quick-hides like a group and persists per display; the rolled-up header shows `12:34` while running.
**Tests** — `ToolsWidget.test.tsx` (rail switches tools; rolled-up header shows remaining time); `ToolRail.test.tsx` (`tablist` roles, arrow-key switching, running badge); `TodoTool.test.tsx` (add, edit, delete, toggle, clear completed); `TodoList.test.tsx` (keyboard reorder updates `order`); `tasks.test.ts` (mutations persist; stable reorder); `TimerTool.test.tsx` with fake timers (start counts down; pause freezes; resume continues; stop resets; preset and custom validation; completion fires toast, notify and chime per settings; linked task "Mark done" toggles the task; Space toggles; Esc confirm); `timer.test.ts` (`start` stores `endsAt`; hydrate recomputes remaining; hydrate past `endsAt` → `finished`; `linkTask` clears when the task is deleted); `notifications.test.ts` (IPC creates a `Notification` with the task name; skipped when `timerNotify` off).
**Acceptance** — `npm test -- tools todo tasks timer notifications` green; `e2e/tools.spec.ts`: add 3 tasks, complete 1, reorder, start a 2-minute timer linked to a task, restart the app, tasks identical and the timer still running with less time left.

### Phase 11 — Settings inspector, tray, startup, displays, first run   (Size: M)
**Goal:** Customization UI, tray lifecycle, start-at-login, resilient multi-display restore, first-run onboarding.
**Depends on:** 6, 9, 10.
**Touches:** `src/renderer/components/inspector/Inspector.tsx` (right-side glass panel 320 px per mockup; opening calls `peek(true, {hold:'inspector'})`, closing releases the hold; Appearance: theme System/Dark/Light, opacity slider, blur slider, glow toggle, accent dots; Icons: size, extensions, grid snap; Behavior: quick-hide, Peek shortcut recorder, start with Windows, tools widget, timer sound, timer notification; Data: open data folder, Auto-organize now, reset layout (confirm); About), `src/main/app/tray.ts` (Show/Hide groups · Peek · Tools widget ✓ · Settings · Refresh desktop · Start with Windows ✓ · Quit; tooltip shows timer remaining while running), `src/main/app/autostart.ts` (`setLoginItemSettings({openAtLogin, args:['--autostart']})`), `src/main/storage/display-match.ts` (saved `displayId` → same id; else same `bounds` size **and** position; else same size; else primary; then clamp and de-overlap by 24 px steps), `src/shared/auto-organize.ts` (pure: `(items, workArea) → Group[]` — Apps/Files/Folders/Web links in a 2×2 grid; empty categories skipped) applied by `layout.applyAutoOrganize(groups)` in the renderer, `src/renderer/components/onboarding/FirstRun.tsx`, `src/main/index.ts` (`--autostart` starts to tray without Peek; `before-quit` flushes stores).
**Requirements**
- [ ] Every setting applies live and persists; sliders show their value like the mockup.
- [ ] Removing a monitor moves its groups to the primary display, clamped, de-overlapped.
- [ ] Logs rotate; unhandled main errors are logged and the app keeps running.
**Tests** — `display-match.test.ts` (id; size+position with two identical monitors; size; primary + clamp + de-overlap); `auto-organize.test.ts`; `Inspector.test.tsx` (slider → settings save; theme radio; shortcut recorder rejects invalid); `autostart.test.ts`; `tray.test.ts`.
**Acceptance** — `npm test -- display auto-organize inspector tray autostart` green; `e2e/persistence.spec.ts`: change 3 settings + layout, kill the app 200 ms later, then while closed add one fixture file and delete another, relaunch: settings and layout restored, the new file is placed, the deleted one is hidden.

### Phase 12 — Polish, accessibility, performance, installer   (Size: L)
**Goal:** Ship-quality motion, states, a11y, a measured performance budget and a verified installer.
**Depends on:** all.
**Touches:** `src/renderer/styles/motion.css` (`css-reveal` entrance for groups on launch, 40 ms stagger, honours kill switch; hover elevates group 2 px; roll-up height transition 160 ms), `src/renderer/components/feedback/ErrorBoundary.tsx`, `EmptyState.tsx`, skeleton tiles while icons load, `README.md`, `docs/USER_GUIDE.md`, `electron-builder.yml` (NSIS per-user, run after finish, no desktop shortcut, `deleteAppDataOnUninstall: false`), `scripts/perf-fixture.ts` (12 groups / 200 items, 150 `.lnk`), `e2e/perf.spec.ts` (during Peek so the window is unoccluded: scripted 3 s group drag, in-page `requestAnimationFrame` timestamps → p95 frame time; cold and warm startup-to-icons both reported), `STUDY_GUIDE.md`.
**Requirements**
- [ ] `prefers-reduced-motion` and the settings kill switch remove all transitions; reduced-transparency removes blur.
- [ ] All interactive elements keyboard-reachable with visible focus; context menus open with `Shift+F10`/menu key; roles and labels verified.
- [ ] Perf acceptance on the fixture: p95 frame ≤ 18 ms over the scripted drag; scan ≤ 300 ms; warm startup-to-icons ≤ 1.5 s; cold startup-to-icons reported (no budget, first measurement).
- [ ] Installer installs, launches to tray, and uninstalls cleanly; packaged app loads koffi (`verify:koffi`).
**Tests** — `a11y.test.tsx` (`vitest-axe` on canvas with 2 groups + todo: no violations); `motion.test.tsx` (kill switch strips `transition`); `e2e/perf.spec.ts`; `e2e/installed.spec.ts` (launches `dist/win-unpacked/Taskyard.exe`, tray exists, seated above shell window).
**Acceptance** — `npm run typecheck && npm run lint && npm test` green; on Windows `npm run test:e2e:win && npm run dist && npm run verify:koffi && npm run verify:zorder` green against the packaged exe.

## Requirements trace

| Brief requirement (quote) | Phase | Test |
|---|---|---|
| "arrange desktop icons, files, folders, and shortcuts into named groups directly on their desktop" | 2, 4, 5, 7 | `verify-zorder`, `scanner.test`, `lnk-parser.test`, `GroupWindow.test` |
| "create … groups" | 7 | `Marquee.test`, `e2e/groups` |
| "rename" | 7 | `RenameInline.test` |
| "resize" | 7 | `GroupWindow.test` (handles, min size) |
| "minimize" | 7 | `GroupWindow.test` (roll-up) |
| "reposition groups" | 7 | `GroupWindow.test` drag, `geometry.test` clamp |
| "organize their contents using drag and drop" | 8 | `useItemDrop.test`, `e2e/dnd` |
| "optional to-do panel" | 10, 11 | `ToolsWidget.test`, `Inspector.test` (toolsEnabled) |
| "add, edit, delete, and reorder tasks" | 10 | `TodoTool.test`, `TodoList.test` |
| "checkboxes to mark them complete" | 10 | `TodoTool.test` toggle |
| "a timer there … same design pattern … same section where the tools are on the side" (addition) | 10 | `ToolRail.test`, `ToolsWidget.test` |
| "start and pause and stop the timer" (addition) | 10 | `TimerTool.test`, `timer.test`, `e2e/tools` |
| "clean, lightweight" | 12 | `e2e/perf` frame-time + startup budget |
| "customizable" | 11 | `Inspector.test` |
| "automatically save desktop layouts and tasks between sessions and on startup" | 3, 11 | `json-store.test` flush, `e2e/persistence` |
| "follow the stardock fences" | 7, 9 | quick-hide, Peek, roll-up, marquee tests |
| "influenced by @designinpo.html" | 6, 11 | `tokens.css`, Inspector layout |
| "translucent glass feel … @taskbarDesign.jpg" | 6 | `glass.css`, light tokens, `theme.test` |

## Non-goals

- Folder Portals, automation rules, Desktop Pages, snapshots — Fences extras beyond "simple"; the data model does not preclude them.
- Hiding Explorer's icon layer via registry — unnecessary because Taskyard covers the desktop.
- Restoring Explorer's existing icon positions on first run (undocumented `ItemPos` blobs); Auto-organize covers onboarding.
- Cross-monitor drag, non-Windows OS, auto-update, telemetry, cloud sync, Windows Spotlight's "Learn about this picture" affordance.

## Challenge

Challenger (Deep, `fable`) returned 9 BLOCKERs; every fix is applied above.

| BLOCKER | Fix applied |
|---|---|
| Win+D moves the desktop window to the top of the z-order (Raymond Chen 2024-10-21), so a bottom window is hidden even when not minimized, and the old acceptance (`IsWindowVisible && !IsIconic`) would pass falsely | Decision 2 rewritten: seat *above the shell window*, foreground WinEvent hook + poll re-seat; `verify:zorder` asserts `isAbove(taskyard, shellWindow)` after `ToggleDesktop()` and after an Explorer restart |
| `transparent:true` brings Aero-Snap/maximize/flicker bugs for no benefit since we paint the wallpaper | Opaque window, `roundedCorners:false`; quick-hide reveals the wallpaper layer |
| Subclass proc re-entrancy / swallowed `DefSubclassProc` on exception; message during `DestroyWindow` | try/catch → `DefSubclassProc`; `RemoveWindowSubclass` on `close`; `SWP_NOZORDER` respected |
| Path-keyed layout: crash between `fs.rename` and debounced save orphans placement; case-only renames; `toLowerCase` ≠ NTFS upcase | Decision 7: NTFS file-id keys + `paths[id]`; `ops.json` journal for moves; `toUpperCase` for remaining path compares |
| `sandbox:false` justified by `webUtils`, but `webUtils` is available in sandboxed preloads | `sandbox:true` |
| Node `fs.stat` has no hidden/system attributes; OneDrive placeholders would hydrate on icon extraction; Public Desktop `EPERM`; long paths; dead UNC `.lnk` blocks main thread; icon alpha straight vs premultiplied; DPI | Phase 4 split from icons (Phase 5): `GetFileAttributesW`, placeholder + readonly flags, `\\?\` prefix, TS `.lnk` parser (Decision 12), premultiply + mask fallback, `ceil(64 × scaleFactor)` |
| Per-monitor wallpapers exist on this machine (`Transcoded_003`); HDR `.jxr` undecodable | Phase 6: `IDesktopWallpaper` via koffi COM, monitor RECT matching, transcoded-cache fallback, settings hint |
| `webContents.startDrag` runs a modal loop while a dnd-kit drag is active | Phase 8: cancel dnd-kit, snapshot selection, then IPC |
| Perf numbers uncited; occluded bottom window is rAF-throttled so the counter measures throttling | Phase 12: measure during Peek, p95 frame ≤ 18 ms, scan ≤ 300 ms, warm ≤ 1.5 s, cold reported; benches in Phases 4 and 5 |
| Interactive Windows tests cannot run headless; jsdom lacks `setPointerCapture` | `test` vs `test:e2e:win` split; pointer-capture polyfills in `setupTests.ts`; `user-event` pointer API; assumption 17 |

Also applied from the verdicts: koffi packaged smoke test in Phase 1; resize handles `stopPropagation`; auto-unpeek paused while typing; display match by size **and** position; Phase 8 depends on Phase 4; cross-volume move verified by SHA-256; auto-hide-taskbar check and 1 px inset in Phase 2.

## Gap pass

The Deep-tier gap pass returned 21 patches; all are applied above: renderer `items` store and event wiring (3/4); enumerated bridge events and `taskyard.on` (3); `displayId`/`scaleFactor` delivery per window (2); icon px from max scaleFactor (5); `reconcile`/`lastSeen` prune and new-item placement (7); boot order and journal rollback events (3); `dev:ino` ids (3/4); watcher path→id map (4); top-level `paths` (3); Peek source of truth in main with holds (2/9/11); `ConfirmDialog` moved to 7 and `Toaster` to 3; `app:quit`/`app:openExternal`/`desktop:rescan` (3/4); `moveGroupToDisplay` (7); pure shared auto-organize (11); `RegGetValueW` and the `getWallpaperForMonitor` declare/implement split (2/6); `backgroundThrottling:false` (2); Phase 7 depends on 4; reconcile-on-boot e2e step (11).

## Handoff prompt

You are the orchestrator implementing `docs/plans/2026-09-21-taskyard/plan.md`. Read it fully, then `docs/plans/2026-09-21-taskyard/research.md` for sources and `docs/plans/2026-09-21-taskyard/brief.md` for the verbatim brief and design-input notes. Read `design/designInpo.html` and `design/taskbarDesign.jpg` before Phase 6.
Start with "Setup & commands": install, env var names, and confirm test/lint/build run. Work on branch `taskyard` (run `git init` first — the directory is not a repo). Follow TDD for every phase: write the named failing tests first, then the smallest implementation, then refactor.
Execute phases in order; a phase is done only when its Acceptance passes and its named tests are green. Interactive Windows checks (`verify:zorder`, `verify:koffi`, `test:e2e:win`) run on this machine (Windows 11 25H2). Commit per phase with the phase name; no AI attribution in commits.
Decisions are LOCKED — do not relitigate. If a lock proves impossible, write the conflict into plan.md under "## Blocks" and stop.
Assumptions tagged "(assumed — not in brief)" may be revised only if the code proves them wrong; note the change in plan.md.
Before implementing group entrance motion (Phase 12), read `C:\Users\doa92\.claude\design-patterns\INDEX.md` and `scroll-choreography/00-architecture.md`, and copy `code/motion-variables.css` verbatim.
Use subagents for independent phases (max 5); keep the main thread for integration and verification. Phases 3 and 2 are independent after Phase 1; Phases 5 and 6 are independent after Phase 4; Phases 9 and 10 are independent after Phase 8.
After the last phase, run every phase's Acceptance once more end-to-end. Update `STUDY_GUIDE.md` after each phase. Never ask the user questions mid-run.
Report: phase · tests run · what deviated from the plan and why.

## Deviations log (implementation)

Recorded during the build. Locked decisions are unchanged unless listed under Blocks (none so far).

- **Phase 1** — `@dnd-kit/sortable@10` (6.x requires core 5; 10 pairs with core 6.3); `@vitejs/plugin-react@5` (6 needs Vite 8, unsupported by electron-vite 5); renderer-only packages are devDependencies (keeps `app.asar` at 6.7 MB); shadcn `components.json` hand-written (CLI 4.21 is interactive and dropped `new-york`); `.gitattributes` forces LF; `noImplicitAny: true` set explicitly (the electron-toolkit base disables it, which contradicted Decision 11).
- **Phase 2** — `thickFrame: false` (Electron's default frame made the window rect exceed the monitor, which tripped the shell's fullscreen heuristic and stopped the auto-hide taskbar); windows are shown with `showInactive()` (raw `ShowWindow` left Chromium unpainted); the sentinel also re-seats when a visible app window sits between Taskyard and the shell window (Win+D undo restores apps beneath it) and uses a topmost flip because `HWND_TOP` from a background process is ignored; only poll-detected fights back off; Alt+F4 (`SC_CLOSE`) is swallowed and the default application menu is removed, while a raw `WM_CLOSE` from another process quits gracefully; a koffi load failure on Windows shows an error dialog and quits instead of falling back to the fake; real-Win32 unit tests moved to the opt-in `npm run test:win32`; `verify:zorder` gained a 6th automated check (auto-hide taskbar) and uses a stand-in window when the user's Notepad is open.
- **Phase 3** — persistence uses optimistic concurrency: main keeps a per-store `revision`, saves carry `baseRevision`, stale saves are rejected and the renderer rebases pending pure updaters (one window per display writes concurrently); extra channels `storage:status` (recoveries are pulled at hydration, because stores load before any window exists) and `storage:changed` (broadcast to all windows); every store mutation is an updater over current data (`layout-mutations.ts`, `tasks-mutations.ts`); reconcile writes must come from a single writer.
- **Phase 4** — layout `paths[id]` on rename is written by main (single writer); read-only folders are detected with a Win32 access probe (`CreateFileW` with `FILE_ADD_FILE|FILE_DELETE_CHILD`) because `fs.access(W_OK)` ignores ACLs on Windows; cross-volume moves copy to a temporary name and rename into place only when complete. Renames and same-volume moves use `MoveFileExW` without replace (`fs.rename` overwrites on Windows); IPC results are typed objects rather than thrown errors; `DesktopItem` gains `targetRemote`, `iconPath`, `iconIndex`; an atomic save (new file id, same path) re-keys the placement; journal replay never deletes a verified destination; drive and share roots are refused as move sources.
- **Phase 6** — blur is capped at 20 px (risk-table budget) although settings allow 40; `--glass-opacity` = setting/100 with the light theme adding .22; wallpaper change detection = WM_SETTINGCHANGE hook + Themes-folder watch + 60 s poll + display changes; the smoke paint test uses a magenta marker because fit letterbox bars are legitimately black.
- **Phase 5** — folders and folder shortcuts use the Windows folder icon from `imageres.dll` (Electron returns a drive glyph for folders and a blank page for `.lnk`); shortcut IconLocation and `.url` IconFile are extraction sources; extra `desktop:icons` pull channel for late windows; icons carry a `version` so a changed item replaces or clears its icon; mapped network drives (`GetDriveTypeW` = remote) are treated like UNC and never read.
- **Phase 7** — right-button drag on the desktop draws a group (as in Fences) and left-button drag selects; the empty-state hint shows when a display has loose icons but no groups; the primary display is the one at the virtual-screen origin; `src/shared/auto-organize.ts` landed here (not Phase 11) because the empty-state button needs it; `.glass` `contain: paint` clips hit-testing, so resize handles sit inside the edge.
- **Phase 8** — drag-out also triggers when another app window is under the cursor (dragging onto a window over the desktop never leaves ours); main refuses the OS drag unless the physical button is down (prevents a stuck OS drag loop); the group drop target is the whole group window and the canvas target is a full-window zone; the pre-hand-off cancel uses dnd-kit’s sensor `handleCancel`; unhandled file drops are swallowed and desktop windows block `will-navigate`.
