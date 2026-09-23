# Taskyard — brief (verbatim, supplied 2026-09-21 via /rap)

Build Taskyard, a simple desktop organization app that is a clone/inspired by the Stardock Fences 6 app, that lets users arrange desktop icons, files, folders, and shortcuts into named groups directly on their desktop. Users should be able to create, rename, resize, minimize, and reposition groups, and organize their contents using drag and drop. Include an optional to-do panel where users can add, edit, delete, and reorder tasks, with checkboxes to mark them complete. Keep the interface clean, lightweight, and customizable, and automatically save desktop layouts and tasks between sessions and on startup. The design should follow the stardock fences but influenced by the @designinpo.html and the translucent glass feel should be inspired by the @taskbarDesign.jpg.

## Design inputs (in repo)

- `design/designInpo.html` — "Flux Fences" mockup: black background, deep-blue glass fences (`rgba(0,15,40,0.4)` + `backdrop-filter: blur(16px)`), cyan `#00f2ff` / electric-blue `#0077ff` accents, 18px fence radius, 11px uppercase tracked fence titles, 4-column icon grid with 40px glyph tiles, right-hand "inspector" panel (opacity slider, blur slider, glow toggle, accent color dots, quick-hide toggle), draggable fences clamped to canvas.
- `design/taskbarDesign.jpg` — light "Neo-Tactile" frosted-glass UI kit: white/very light translucent panels, soft shadows, pill buttons, blue `#3b6ef5`-ish active state, cyan glow ring, toggles and sliders with soft depth, hover elevates elements, loading state animates.

## Addition (verbatim, 2026-09-23)

One more feature I would like to add to the section that has the to-do tasks. I also want the ability to have a timer there. It should follow the same design pattern and be in that same section where the tools are on the side. but I can start and pause and stop the timer.
