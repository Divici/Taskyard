# Taskyard user guide

Taskyard organizes your Windows desktop into glass groups. It does not move your files: whatever
you see in Taskyard is still in your Desktop folder, exactly where Explorer shows it.

## First run

The first time Taskyard starts it offers **Auto-organize**: four groups by type (Apps, Files,
Folders, Web links). Choose **Keep my desktop as it is** to start with your icons loose instead;
you can auto-organize later from the desktop menu or Settings.

Taskyard lives in the **tray** (the notification area by the clock). Windows 11 may put new tray
icons in the overflow (the **^** arrow); drag the Taskyard icon onto the taskbar to keep it in
view.

## Icons

- **Open**: double-click, or select and press **Enter**.
- **Select**: click; **Ctrl+click** adds or removes one, **Shift+click** selects a range,
  **Ctrl+A** selects all. Drag on empty desktop with the left button to select with a box.
- **Rename**: **F2** (this renames the file on disk).
- **Delete**: **Delete** sends the selection to the Recycle Bin after you confirm.
- **Copy as path**: **Ctrl+Shift+C**.
- **Menu**: right-click, or **Shift+F10** / the menu key — see [Right-click menus](#right-click-menus).
- Arrow keys move the selection.

Drag icons to move them on the desktop or into a group. Drag an icon out onto another app or an
Explorer window to hand the file to it. Drop files from Explorer onto Taskyard to move them into
your Desktop folder; an **Undo** toast gives you 6 seconds to take it back.

## Right-click menus

Right-click, **Shift+F10**, or the menu key opens a menu at the pointer (keyboard: at the
focused item). Taskyard shows the **real Windows menu** — the same one Explorer would show —
with Taskyard's own items mixed in, so none of the regular right-click options go away.

- **Empty desktop**: the native Windows background menu (New ▸, Paste, Display settings,
  Personalize, Open in Terminal, your shell extensions) with a **Taskyard ▸** submenu added at
  the top (New group here, Auto-organize…, Sort loose icons, Show/Hide tools widget, Refresh
  desktop, Taskyard settings, Quit Taskyard). **View ▸** and **Sort by ▸** are replaced with
  Taskyard's own icon-size and sort-loose-icons submenus, since Windows' versions act on an
  icon layer Taskyard doesn't use; Refresh rescans the desktop, and Paste/Undo act on your real
  Desktop folder.
- **An icon** (or a whole selection, when every selected item is in the same folder): the
  native Windows file menu (Open, Open with, Send to, Cut, Copy, Create shortcut, Delete,
  Properties, and any shell extensions you have installed), with **Remove from group** added
  near the top when the icon is in a group. **Rename** opens Taskyard's inline rename instead
  of Windows' own — it's hidden entirely when Taskyard can't rename the selection (several
  items selected, or a read-only Public Desktop item).
- **Shift+right-click** (or Shift + the menu key) adds Windows' extended verbs, the same ones
  you'd see holding Shift in Explorer's own menu.
- **If the native menu can't be shown** — rare: a crash, a timeout, or Windows refusing it the
  foreground — Taskyard's own menu opens at the same spot instead. The right-click never comes
  up empty.
- The group's **…** menu and the tools widget's menu are always Taskyard's own menus; Windows
  has no equivalent for either.

## Groups

- **Make one**: right-click empty desktop › **New group here**, or **right-drag** a box around
  some icons (as in Fences).
- **Move**: drag the title bar. **Resize**: drag any edge or corner.
- **Snapping**: while you move or resize, a group's edges and centre line up with the other
  groups, the tools widget and the screen edges when they come within 8 px — a thin accent guide
  line shows what it lines up with. Elsewhere it follows the grid (Settings › Snap to grid, in
  8, 16 or 32 px steps). Hold **Alt** while dragging to place it freely.
- **Roll up**: one click on the chevron rolls the group up to its title bar; one more click rolls
  it back down. Double-clicking the title does the same. A group you roll down comes to the front,
  so it reads over its neighbours; near the bottom of the screen it grows upward instead of
  running off it.
- **Reorder icons**: drag an icon to another spot in the same group; an accent bar shows where it
  lands. A group sorted by name, type or date switches to **Manual** and keeps your order.
- **Rename**: double-click is roll-up, so use **F2** on the title bar or the group menu.
- **Group menu** (right-click the title, the **…** button, or **Shift+F10**; always Taskyard's
  own menu — see [Right-click menus](#right-click-menus)): rename, roll up,
  sort by manual / name / type / modified, icon size, move to another display, keep visible during
  quick-hide, delete (the icons go back to the desktop; no file is deleted). The **Sort by**,
  **Icon size** and **Move to display** submenus open on hover, on click, or with **→**.

## Quick-hide and Peek

- **Quick-hide**: double-click empty desktop to hide every icon and group and see the plain
  wallpaper; double-click again to bring them back. Groups marked "keep visible" stay.
- **Peek**: press **Ctrl+Alt+Space** (rebind it in Settings) or left-click the tray icon to show
  your groups over every open window. The taskbar stays usable on top. Peek ends when you click
  empty desktop, switch to another app, press the shortcut again, or after 8 seconds idle.

## Tools widget: tasks, timer and stopwatch

The floating widget has three tabs along its top: **Tasks · Timer · Stopwatch**. Click one, or
focus the tabs and use **←**/**→** (**Home**/**End** jump to the first or last). A glowing dot on
the Timer or Stopwatch tab means it is running.

Each tab's content is centred in the space it's given. Drag the widget taller and Timer and
Stopwatch centre themselves in the extra room; Tasks keeps its **Add a task…** row pinned under
the tabs and centres only the list below it. Content taller than the widget starts at the top
and scrolls — nothing is ever clipped.

- **Tasks**: click anywhere on the **Add a task…** row, type, then press **Enter** or click the
  round **+** button (it lights up once there is text). The field stays ready for the next task.
  Tick a task to complete it; completed tasks collapse under **Completed**. Double-click a task to
  edit it, drag the handle to reorder.
- **Timer**: presets of 5, 15, 25 and 45 minutes or a custom 1–180 minutes; **Start**, **Pause**,
  **Resume**, **Stop**. **Space** starts or pauses while the timer has focus. Link a task with
  **Focus on…**; it shows as **Focus: <task>** under the ring (hover it for the full name).
- **When the countdown ends**: the ring pulses, a chime plays (Settings › timer sound) and a Windows
  notification appears by the clock (Settings › timer notification). With the notification turned
  off — or if Windows cannot show it — a small Taskyard pop-up appears above the taskbar instead.
  With a linked task, the timer offers **Mark done**; once the task is done it shows **Done ✓** with
  **Undo**, and it always follows the task: untick it in Tasks and **Mark done** comes back.
- **Stopwatch**: **Start**, **Pause**, **Resume**, **Reset** and **Lap**. Laps list newest first
  with each lap's split and running total (the latest 50 are kept). It shows `h:mm:ss.t` and keeps
  counting while Taskyard is closed or the PC sleeps. **Space** starts or pauses while it has focus,
  and **Focus on…** links a task like the timer. Rolled up on the Stopwatch tab, the widget's title
  bar shows the running time (a running countdown takes priority).

Move, resize and roll up the widget like a group. Hide it from its menu, the desktop menu or the
tray; turn it off entirely in Settings.

## Settings

Right-click empty desktop › **Settings**, or the tray › **Settings…**. Changes apply at once.

- **Appearance**: theme (System, Dark, Light), glass opacity and blur, emissive glow, accent colour.
  With Windows' "Transparency effects" off, glass turns opaque.
- **Icons**: icon size, file extensions, snap to grid and its grid size (8, 16 or 32 px).
- **Behavior**: quick-hide on double-click, the Peek shortcut, Start with Windows, the tools
  widget, timer sound and notification, and **Reduce motion**.
- **Data**: open the data folder, auto-organize now, reset the layout.

### Motion

Groups fade up one after another when Taskyard starts, lift slightly under the pointer and roll
up smoothly. **Reduce motion** turns every animation off and shows everything in its final place
at once. Turning off Windows' **Settings › Accessibility › Visual effects › Animation effects**
does the same.

## Keyboard

Everything is reachable with **Tab**; the focused control shows a ring. The desktop itself is a
Tab stop: **Shift+F10** there opens the desktop menu. Inside a list of icons the arrow keys move
and **Tab** leaves the list.

## Multiple monitors

Each monitor has its own groups. Move a group to another display from its menu. If a monitor is
unplugged, its groups are shown on another display and go back when it returns.

## Where your data is

`%APPDATA%\Taskyard` holds your layout, tasks and settings (Settings › Data › Open data folder).
Uninstalling Taskyard keeps this folder so a reinstall picks up where you left off. Delete it to
start fresh.

## Troubleshooting

- **The desktop looks blank after an error**: Taskyard shows a "hit a problem" card with
  **Reload**; your files are never affected.
- **Peek shortcut does nothing**: another app may own the key combination; Settings shows it and
  lets you record a different one.
- **Wallpaper looks wrong** (HDR `.jxr` wallpapers): Taskyard falls back to Windows' cached copy;
  Settings › Appearance explains.
- **Logs**: `%APPDATA%\Taskyard\logs\main.log`.
