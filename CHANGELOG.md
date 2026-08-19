# Change Log 

## 2.2.6
- Fixed: Renaming a note by editing its title in the Obsidian editor (or anywhere
  outside the plugin) could break the note. When a note file was renamed but its
  folder was not yet in sync, the next plugin action wrapped the file in a brand
  new folder, abandoning the original folder. That orphaned the note's nested
  notes (they jumped to the top level), hid the note from the panel, and left a
  duplicate order index behind. The plugin now renames the existing note folder
  back onto its file instead of creating a new one, so nested notes and the order
  index are preserved.
- Fixed: Nested notes no longer fall out of the hierarchy when an intermediate
  folder temporarily stops being a note. Each note now attaches to the closest
  note above it rather than only to its direct parent.
- Fixed: Dropping or nesting a note onto a target whose folder was out of sync no
  longer silently does nothing; the target is repaired first so the move happens.
- Fixed: Reordering siblings no longer produces duplicate indices. Indices already
  held by other sibling folders are skipped, and a note folder that becomes empty
  after a note is moved out of it is removed.
- Added: Renames the plugin could not observe (panel closed, or made while one of
  the plugin's own operations was still running) are now detected and repaired the
  next time the plugin runs, restoring the note folder to match its file.

## 2.2.4
- Maintenance: dropped legacy backward-compatibility entries from `versions.json`;
  the plugin now targets Obsidian `1.13.7+` only.

## 2.2.3
- Fixed: Newly created notes had no order index, and an index was not regenerated
  after a rename, so manual ordering/reordering did not work. `renameNote` now
  renumbers the note's siblings, (re)assigning the index on every rename.
- Fixed: Settings page showed up empty. The declarative `getSettingDefinitions()`
  implementation took precedence over `display()` on Obsidian 1.13+ but used an
  invalid type, so nothing rendered. Reverted to the `display()` UI.
- Raised `minAppVersion` to `1.13.7` so the `no-unsupported-api` check passes
  for all used Obsidian APIs.

## 2.2.2
- Change: Dragging a note from the panel into a note's text now inserts a link
  to that note (for example `[[My note]]`) showing only the note name, instead of
  the full vault path. Reordering notes inside the panel still uses the file path.

## 2.2.1
- Fixed: Dragging a note no longer accidentally drops it at the vault root. A drop
  on a note row now stops propagation so it is never treated as a drop on empty
  space (which promotes to top level). `dropHandled` is reset on drag start/end.
- Fixed: The drop indicator (before/after line) now shows for any valid target, not
  only for notes in the same parent folder. Reordering across folders now works:
  the note is moved into the target's parent and then positioned relative to it.

## 2.2.0
- Change: The sort index is stored only on the note folder (`3 My note/My note.md`),
  so it no longer appears in the tab title or the note's inline title.
- Change: Notes whose folder has no index are still listed in the hierarchy and are
  sorted after the indexed ones.
- Change: Reordering notes now renames only folders, leaving note files untouched.
- Added: Folder and note file names are kept synchronized in both directions when
  renamed from the plugin, the tab title, the inline title or the file explorer.
  The folder keeps its index, the file keeps the plain name.
- Added: One-time migration that strips the index from existing note files while
  preserving links.

## 1.0.0
- First Release 
- Features: 
  - Drag and drop to organise notes. 
  - Collapse or expand in view. 
  - Hide folders, non-markdown files. 
- Settings: 
  - show file icon
  - show folder path