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
- **Menu**: right-click, or **Shift+F10** / the menu key.
- Arrow keys move the selection.

Drag icons to move them on the desktop or into a group. Drag an icon out onto another app or an
Explorer window to hand the file to it. Drop files from Explorer onto Taskyard to move them into
your Desktop folder; an **Undo** toast gives you 6 seconds to take it back.

## Groups

- **Make one**: right-click empty desktop › **New group here**, or **right-drag** a box around
  some icons (as in Fences).
- **Move**: drag the title bar. **Resize**: drag any edge or corner.
- **Roll up**: double-click the title, or the chevron: only the title bar stays.
- **Rename**: double-click is roll-up, so use **F2** on the title bar or the group menu.
- **Group menu** (right-click the title, the **…** button, or **Shift+F10**): rename, roll up,
  sort by name / type / modified, icon size, move to another display, keep visible during
  quick-hide, delete (the icons go back to the desktop; no file is deleted).

## Quick-hide and Peek

- **Quick-hide**: double-click empty desktop to hide every icon and group and see the plain
  wallpaper; double-click again to bring them back. Groups marked "keep visible" stay.
- **Peek**: press **Ctrl+Alt+Space** (rebind it in Settings) or left-click the tray icon to show
  your groups over every open window. The taskbar stays usable on top. Peek ends when you click
  empty desktop, switch to another app, press the shortcut again, or after 8 seconds idle.

## Tools widget: tasks and timer

The floating widget has a tool rail on its left.

- **Tasks**: type in **Add a task** and press **Enter**. Tick a task to complete it; completed
  tasks collapse under **Completed**. Double-click a task to edit it, drag the handle to reorder.
- **Timer**: presets of 5, 15, 25 and 45 minutes or a custom 1–180 minutes; **Start**, **Pause**,
  **Resume**, **Stop**. **Space** starts or pauses while the timer has focus. Link a task with
  **Focus on…**; when the countdown ends you get a chime and a Windows notification (both can be
  turned off in Settings) and can mark the task done.

Move, resize and roll up the widget like a group. Hide it from its menu, the desktop menu or the
tray; turn it off entirely in Settings.

## Settings

Right-click empty desktop › **Settings**, or the tray › **Settings…**. Changes apply at once.

- **Appearance**: theme (System, Dark, Light), glass opacity and blur, emissive glow, accent colour.
  With Windows' "Transparency effects" off, glass turns opaque.
- **Icons**: icon size, file extensions, snap to grid.
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
