# Taskyard — centred tool content and the native Windows right-click menus

**Mode:** follow-up to `docs/plans/2026-09-21-taskyard/plan.md` (all 12 phases shipped, v0.2.0 released)
**Branch:** `taskyard` (pushes to `main` on https://github.com/Divici/Taskyard)
**Date:** 2026-09-29

## Brief (user, verbatim essentials)

1. "Content of [the tools widget] should be in the center of the space that is given. So if I drag the panel to make it longer heightwise, it should move the content to be in the center of the panel."
2. "I'm not able to use the regular right click options that Windows comes with on the desktop. I need to still be able to use all the regular right click options."

## Decisions (user-approved 2026-09-29 — LOCKED)

1. **Timer and Stopwatch** content is centred vertically (and horizontally) in the widget body at any height. **Tasks** keeps the "Add a task…" row pinned under the tabs; only the list area below it is centred. Content taller than the body starts at the top and scrolls — nothing is ever clipped.
2. **Right-click on empty desktop** shows the **real Windows desktop background menu** at the cursor (New ▸, Paste, Display settings, Personalize, Open in Terminal, shell extensions). Taskyard's own canvas items move into a **Taskyard ▸** submenu at the top of that same menu. Windows items that would act on Explorer's hidden icon layer are mapped to Taskyard: View ▸ icon size → Taskyard icon size; Sort by → sort loose icons; Refresh → rescan; Show desktop icons → quick-hide.
3. **Right-click on an icon** (one or several selected) shows the **real Windows file menu** for those files (Open, Open with, Send to, Cut, Copy, Create shortcut, Rename, Delete, Properties, shell extensions) with **Remove from group** added. Changes made through the menu are picked up by the existing watcher; a file created via **New ▸** is placed at the right-click point and opens inline rename.
4. The group "…" menu and the tools-widget menu stay Taskyard menus.
5. If the native menu cannot be shown, Taskyard's current menu is shown instead (never a dead right-click).

## Design decisions made in this plan (assumed — not in brief)

- **The shell menu runs in an isolated helper process**, not in the Electron main process. Third-party shell extensions load into whatever process shows the menu; a crashing extension must not take Taskyard's desktop layer down, and `TrackPopupMenuEx`'s modal loop must not freeze the main process (IPC, z-order sentinel, storage flush). Helper = an Electron `utilityProcess` (Node + koffi) that owns a hidden, message-only-capable owner window on its own thread, shows the menu, invokes the chosen command, and reports back over a `MessagePort`. If it dies, main logs it, respawns on next use, and the renderer falls back to the Taskyard menu for that click. (Correction to what was said in chat: this is isolation, not "Taskyard restarts itself".)
- Menus use the classic full menu (what Windows 11 shows under "Show more options"); Windows exposes no API for the compact Windows 11 menu.
- If the helper-process approach proves impossible in Phase 2's spike (see Blocks rule), fall back to in-process menus in main with a try/catch and a crash-safe relaunch, and record it under `## Blocks`.

## How it works

1. Renderer gets `contextmenu` on empty canvas or on an icon (or Shift+F10 / menu key) → calls `taskyard.shellMenu.show({ kind: 'background' | 'items', displayId, ids?, point })` with the point in screen pixels.
2. Main resolves paths (item ids → current paths; background → the user Desktop folder), builds the Taskyard items (labels + stable ids), calls `AllowSetForegroundWindow(helperPid)`, and posts the request to the helper.
3. Helper: `CoInitializeEx(STA)`; background → `SHGetDesktopFolder` → the background `IContextMenu` (see Phase 2 spike for which API yields the full set); items → `SHParseDisplayName` per path → `SHBindToParent` → `IShellFolder.GetUIObjectOf(hwnd, n, pidls, IID_IContextMenu)` (multi-select only when all paths share a parent folder; otherwise the right-clicked item alone). `CreatePopupMenu` → `QueryContextMenu(hmenu, 0, 1, 0x7FFF, CMF_NORMAL | CMF_CANRENAME | (shift ? CMF_EXTENDEDVERBS : 0))` → insert Taskyard items (ids ≥ 0x8000) → `SetForegroundWindow(owner)` → `TrackPopupMenuEx(TPM_RETURNCMD | TPM_RIGHTBUTTON)` → `PostMessage(owner, WM_NULL)` (KB135788).
4. While the menu is open the owner's WNDPROC forwards `WM_INITMENUPOPUP`, `WM_DRAWITEM`, `WM_MEASUREITEM`, `WM_MENUCHAR` to `IContextMenu3.HandleMenuMsg2` (or `IContextMenu2.HandleMenuMsg`) so **New ▸ / Send to ▸** populate and owner-drawn icons render.
5. Result: Taskyard id → returned to the renderer to run the existing action; shell id → `GetCommandString(GCS_VERBW)`; intercept verbs `rename` (→ Taskyard inline rename), and background `view`/`arrange`/`refresh`/icon-layer toggles (→ mapped Taskyard actions); otherwise `InvokeCommand(CMINVOKECOMMANDINFOEX{ fMask: CMIC_MASK_UNICODE | CMIC_MASK_PTINVOKE | (ctrl/shift masks), lpVerb: MAKEINTRESOURCE(id - 1), ptInvoke, nShow: SW_SHOWNORMAL, hwnd: owner })`. Release every COM object and `DestroyMenu` on every path.
6. New ▸ follow-up: main arms a 3 s "expect a new item" window with the right-click point; the next watcher `added` item in the Desktop folder is placed there (primary-window single writer rule as today) and the renderer opens inline rename on it.

## COM / Win32 reference (verify each against the SDK headers during the spike)

- IIDs: `IID_IShellFolder {000214E6-0000-0000-C000-000000000046}`, `IID_IContextMenu {000214E4-0000-0000-C000-000000000046}`, `IID_IContextMenu2 {000214F4-0000-0000-C000-000000000046}`, `IID_IContextMenu3 {BCFCE0A0-EC17-11D0-8D10-00A0C90F2719}`.
- IShellFolder vtable: 3 ParseDisplayName, 4 EnumObjects, 5 BindToObject, 6 BindToStorage, 7 CompareIDs, 8 CreateViewObject, 9 GetAttributesOf, 10 GetUIObjectOf, 11 GetDisplayNameOf, 12 SetNameOf.
- IContextMenu vtable: 3 QueryContextMenu, 4 InvokeCommand, 5 GetCommandString; IContextMenu2: 6 HandleMenuMsg; IContextMenu3: 7 HandleMenuMsg2.
- Functions: shell32 `SHGetDesktopFolder`, `SHParseDisplayName`, `SHBindToParent`, `SHCreateDefaultContextMenu` (candidate for the background menu with `HKCR\DesktopBackground` + `HKCR\Directory\Background` keys); ole32 `CoTaskMemFree` for PIDLs (`ILFree`); user32 `CreatePopupMenu`, `InsertMenuItemW`, `AppendMenuW`, `TrackPopupMenuEx`, `DestroyMenu`, `SetForegroundWindow`, `AllowSetForegroundWindow`, `CreateWindowExW`, `RegisterClassExW`, `DefWindowProcW`, `PostMessageW`, `GetCursorPos`.
- Reuse `src/main/win32/com.ts` (`vtableCall`, `parseGuid`, `checkHr`, Release) — do not duplicate it; move shared pieces to a module the helper can import.
- CMINVOKECOMMANDINFOEX and MENUITEMINFOW are x64 structs with pointer alignment — declare with `koffi.struct` and assert `koffi.sizeof` against the SDK sizes in a test.

## Phases

### Phase 1 — Centre the tools widget content (Size: S)

**Touches:** `src/renderer/components/tools/ToolsWidget.tsx`, `timer/TimerTool.tsx`, `stopwatch/*`, `todo/TodoTool.tsx`, `tool-styles.ts`.
**Requirements**

- [ ] Widget body is a flex column with `min-h-0` and `overflow-y-auto`; Timer/Stopwatch content is one block with `my-auto` (centres when shorter, scrolls from the top when taller).
- [ ] Tasks: input row pinned under the tabs; the list region fills the rest and centres its content the same way (empty state included).
- [ ] Works at 280 px min width, after roll-up/expand, in dark and light.

**Tests** — unit: the body/content classes and structure; e2e (`e2e/tools.spec.ts`): resize the widget taller with the real mouse → each tool's content centre is within 2 px of the body centre; with 50 laps the lap list starts at the top and scrolls (first control visible, `scrollTop` 0).

**Acceptance** — `npm test -- tools` green; the e2e above green; screenshots of all three tools at two heights.

### Phase 2 — Shell-menu helper spike (gate) (Size: M)

**Goal:** prove the isolated helper can show the real desktop background menu and a file menu, with New ▸ and Send to ▸ populated, and invoke a verb — before any UI work.
**Touches:** `src/main/shell-menu/helper.ts` (utilityProcess entry, bundled by electron-vite as a separate main-side entry), `src/main/shell-menu/host.ts` (spawn, MessagePort protocol, respawn, timeouts), `src/main/shell-menu/protocol.ts` (zod-validated messages), `src/main/win32/shell-menu-api.ts` (interface + koffi impl + fake), `scripts/spike-shell-menu.ts`.
**Requirements**

- [ ] Decide the background-menu API empirically: compare `IShellFolder(desktop).CreateViewObject(IID_IContextMenu)` with `SHCreateDefaultContextMenu` (+ `DesktopBackground`/`Directory\Background` keys); pick the one whose item list includes New ▸, Paste, Display settings, Personalize (and Open in Terminal if installed). Record both item lists in the report.
- [ ] The spike script, run with a temp folder, enumerates both menus' items (walk the HMENU with `GetMenuItemCount`/`GetMenuItemInfoW` after `QueryContextMenu`, and after forwarding `WM_INITMENUPOPUP` for New ▸) WITHOUT showing or invoking anything on the real desktop.
- [ ] The helper survives a thrown JS error and reports it; main respawns a dead helper on the next request; a request times out after 30 s with no menu shown.
- [ ] Packaged build works: the helper entry and koffi are unpacked/loadable (`verify:koffi`-style check for the helper).

**Blocks rule** — if the helper cannot show a working menu (foreground or owner-window limits), stop and write the evidence under `## Blocks` in this file, then implement the in-process fallback described in Design decisions.

**Tests** — headless unit tests with the fake (protocol, respawn, timeout, id mapping); real-Win32 tests in `*.win32.test.ts` (opt-in `npm run test:win32`) that build menus for a TEMP folder and a TEMP file and assert the item/verb lists (e.g. verbs `open`, `copy`, `delete`, `properties`; background contains a "New" submenu with ≥ 2 items after init).

**Acceptance** — spike report with both item lists; `npm test` headless green; `npm run test:win32` green.

### Phase 3 — Native desktop background menu (Size: M)

**Touches:** `src/renderer/components/canvas/CanvasContextMenu.tsx` (becomes the fallback), `DesktopCanvas.tsx`, `src/renderer/lib/shell-menu.ts`, `src/shared/ipc.ts` (+ preload), `src/main/shell-menu/*`, `src/main/app/shortcuts.ts` or a new `new-item-tracker.ts`.
**Requirements**

- [ ] Right-click / Shift+F10 / menu key on empty desktop shows the native background menu at the pointer (keyboard: at the focused element's position). Shift+right-click passes `CMF_EXTENDEDVERBS`.
- [ ] "Taskyard ▸" submenu at the top (then a separator) with: New group here, Auto-organize…, Sort loose icons, Show/Hide tools widget, Refresh desktop, Taskyard settings.
- [ ] Mapped verbs: View ▸ icon size (large/medium/small) → Taskyard `iconSize`; Sort by ▸ → sort loose icons (name/type/date/size where supported); Refresh → `desktop:rescan`; Show desktop icons → quick-hide toggle; Auto arrange / Align to grid → Taskyard grid snap. Items that exist only for Explorer's icon layer and have no Taskyard meaning are removed from the menu. Record the final item mapping table in the report.
- [ ] Paste / New ▸ act on the user's Desktop folder; a New ▸ item appears at the click point with inline rename open.
- [ ] Peek: opening the native menu during Peek keeps Peek (the helper's owner window counts as ours for the foreground check) until the menu closes.
- [ ] Fallback: helper unavailable, timed out or crashed → Taskyard's current Radix menu opens at the same point.
- [ ] IPC `shellMenu:show` is zod-validated + sender-guarded; ids are resolved in main (the renderer never sends paths).

**Tests** — unit: menu request building, Taskyard-id routing, verb mapping table, New-item placement; e2e with the fake shell-menu (`TASKYARD_FAKE_SHELL_MENU=1` returns a scripted choice): right-click → chosen Taskyard item runs; chosen mapped verb runs; helper failure → Radix fallback opens.

**Manual (record in report)** — on this PC: Display settings and Personalize open; New ▸ Folder creates, places and renames; Paste of a copied temp file works; then delete the test items.

### Phase 4 — Native icon menus (Size: M)

**Touches:** `src/renderer/components/icon/IconContextMenu.tsx` (fallback), `useItemList.ts`, `src/main/shell-menu/*`.
**Requirements**

- [ ] Right-click / Shift+F10 on an icon shows the native file menu for the selection (multi-select when all selected items share a parent folder; otherwise the right-clicked item alone). Right-clicking an unselected icon selects it first (Explorer behaviour).
- [ ] "Remove from group" (when the item is in a group) inserted near the top; Taskyard-only "Copy path" kept only if Windows' own "Copy as path" isn't present.
- [ ] Verb `rename` → Taskyard inline rename (keeps the readonly rules). Delete/Cut/Copy/Paste/Create shortcut/Send to/Properties/Open with invoke natively; the watcher reflects results (existing tests stay green).
- [ ] Placeholders (OneDrive online-only) and read-only items still get the native menu; Taskyard never opens the file itself.
- [ ] Fallback to the current Radix icon menu on any failure.

**Tests** — unit: selection→request mapping, shared-parent rule, verb interception; e2e with the fake shell-menu; real-Win32 opt-in test: menu for two temp files in one temp folder contains `delete`, `copy`, `properties` and invoking `delete` via the helper recycles them (temp files only).

**Manual (record in report)** — Open with, Send to ▸ Compressed folder, Properties on a temp copy placed on the desktop by the test; then remove it.

### Phase 5 — Docs, release (Size: S)

- [ ] `docs/USER_GUIDE.md` and README: right-click behaviour, Taskyard ▸ submenu, Shift+right-click extended verbs, fallback.
- [ ] Version 0.3.0 (`npm version 0.3.0 --no-git-tag-version`), `npm run dist`, `npm run verify:koffi`, install/launch smoke of the packaged helper.
- [ ] Append the deviations of this plan to the "Deviations log" in `docs/plans/2026-09-21-taskyard/plan.md`.
- [ ] Release: push `taskyard` → `main`; `gh release create v0.3.0` with the installer uploaded as both `Taskyard-Setup.exe` (the README link) and `Taskyard-0.3.0-setup.exe`. (Only after the user confirms the push.)

## Risks

| Risk                                                    | Mitigation                                                                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Shell extension crashes the menu host                   | Isolated helper process; respawn; Radix fallback                                                                              |
| Helper can't take foreground → menu dismisses instantly | `AllowSetForegroundWindow(helperPid)` from main right before the request; owner window `SetForegroundWindow`; spike proves it |
| New ▸ / Send to ▸ empty                                 | Forward `WM_INITMENUPOPUP`/`WM_DRAWITEM`/`WM_MEASUREITEM`/`WM_MENUCHAR` to `IContextMenu3.HandleMenuMsg2`                     |
| Menu actions act on Explorer's hidden icon layer        | Verb interception + mapping table (Phase 3)                                                                                   |
| Main process frozen during the menu                     | Menu's modal loop runs in the helper, not main                                                                                |
| Multi-DPI placement                                     | Renderer sends DIP point + displayId; main converts to physical px with `screen.dipToScreenPoint`                             |
| Tests touching the real desktop                         | Spike and real-Win32 tests use temp folders only; real-desktop checks are manual and clean up after themselves                |

## Rules for the implementer

Same as the original build (`.superpowers/sdd/plan/implementer-common.md`): TDD red→green→refactor with evidence; `npm test` stays headless (real Win32 only in `*.win32.test.ts` / `npm run test:win32`); pure updaters for every store change; never create, rename, move or delete anything in the real Desktop folders except the listed manual checks, which clean up; leave no stray processes; update `STUDY_GUIDE.md`; commit per phase with the phase name; no AI attribution; don't push without the user's go-ahead. Decisions above are LOCKED; if one proves impossible, write it under `## Blocks` and stop.

## Handoff prompt

You are implementing `docs/plans/2026-09-29-native-menus/plan.md` for Taskyard on branch `taskyard`. Read it fully, then `.superpowers/sdd/plan/implementer-common.md` for the working rules, and skim `.superpowers/sdd/plan/phase-6-report.md` (COM via koffi), `phase-9-report.md` (Peek) and `phase-7-report.md` (canvas/icon menus) for the code you'll touch. Execute the phases in order; Phase 2 is a gate — do not start Phase 3 until the helper shows a working native menu in the spike. TDD for every phase; a phase is done when its Acceptance passes. Commit per phase with the phase name, no AI attribution. Report per phase: tests run, deviations and why. Do not push or release until the user confirms.
