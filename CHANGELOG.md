# Changelog

## [1.2.0] - 2026-07-27

### Fixed

- **Data loss when the storage file is shared.** Every mutation now re-reads the file before applying and saving, so the first action taken in VS Code after an external edit no longer overwrites it. Todos added from the Obsidian plugin, another VS Code window, or another machine through a synced folder are preserved.
- Todos created outside VS Code now appear in the tree without reloading the window.
- A failed save no longer shows the change as if it had been persisted: the file is re-read to revert the mutation on screen, undo/redo history is cleared, and the error message carries the errno (`EPERM: …`).
- A failed read no longer blanks the in-memory list, which could let the next save overwrite the file with an empty one.

### Added

- External change detection: a filesystem watcher on the storage folder plus a periodic check of the file's mtime, needed because synced folders (Synology Drive, OneDrive…) emit no reliable watcher event. A change is only reported when the contents actually differ.
- New setting `toudou.watchExternalChanges` (default: `true`) to turn that off.
- New setting `toudou.watchIntervalSeconds` (`2` | `3` | `5` | `10`, default: `3`).
- New command "Reload Storage File" (`toudou.reloadStorage`) to force an immediate re-read.

### Changed

- Saves go through a temporary file renamed into place, so a reader never observes a half-written file. When the rename is blocked by a sync client holding the file open (`EPERM`, `EACCES`, `EBUSY`, `EEXIST`), the write falls back to a direct write rather than losing the change.

## [1.1.0] - 2026-04-27

### Added

- New command "Add Quick Todo" (`toudou.addQuickTodo`): adds a todo with title only, no category or description prompt
- New setting `toudou.defaultAddMode` (`quick` | `complete`, default: `quick`): controls which flow the `+` button in the TreeView triggers
- Description field at creation is now a simple input box (press Enter to skip); rich Markdown editing remains available via right-click → Edit Description

## [1.0.1] - 2026-04-06

### Fixed

- Fixed hardcoded local path in documentation
- Updated extension identifier from `quentin.toudou` to `Sillot.toudou`

## [1.0.0] - 2026-04-06

### Added

- Todo management (add, complete, delete, restore)
- Categories with emoji support
- Priority levels (low, medium, high)
- In-progress status with green icon
- Drag & drop reordering
- Sort by manual order, priority, category, category + priority
- Undo / redo support (up to 50 states)
- History view for completed todos (Toudones)
- Filter / search in both panels
- Export / import todos as JSON
- Copilot integration via Language Model Tools
- "Open in Copilot" context menu action
- Configurable storage path (per-workspace or global)
- Localization: English, French
- Workspace-scoped persistent storage

### Security

- Import file size limited to 5 MB
- Markdown injection protection in tooltips
- Prototype pollution guards on JSON parsing
- Path traversal validation on custom storage paths
