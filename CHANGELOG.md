# Change Log 

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