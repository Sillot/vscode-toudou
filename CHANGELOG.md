# Changelog

## [1.2.0] - 2026-07-27

### Fixed

- **Data loss when the storage file is shared.** Every mutation now re-reads the file before applying and saving, so the first action taken in VS Code after an external edit no longer overwrites it. Todos added from the Obsidian plugin, another VS Code window, or another machine through a synced folder are preserved.
- Todos created outside VS Code now appear in the tree without reloading the window.
- A failed save no longer shows the change as if it had been persisted: the file is re-read to revert the mutation on screen, undo/redo history is cleared, and the error message carries the errno (`EPERM: …`).
- A failed read no longer blanks the in-memory list, which could let the next save overwrite the file with an empty one. Writes are now refused outright until a read succeeds again, so a file caught truncated mid-sync can no longer be replaced by the little that was salvaged from it.
- The storage file temporarily disappearing — an unmounted drive, a sync client resolving a conflict — no longer empties the views and no longer lets the next write persist that emptiness.
- Fields and entries written by another client are preserved instead of being deleted on the next save. Anything Toudou does not recognize (unknown top-level keys, todos in a shape it cannot validate) is round-tripped untouched.
- The views no longer stay stale after an action that turned out to change nothing (sorting by the current mode, deleting an already-deleted todo): the external change consumed by the re-read is now reported.
- An external write landing between two of our own filesystem calls no longer masks the change until the next edit.
- A storage folder that cannot be created is now reported, instead of silently leaving the extension with no views and no watcher.
- Drag and drop positions a todo against the file's current contents rather than the tree it was dragged from, in one write instead of two, and can no longer give two todos the same position.
- Toggling "in progress" reads the current state from the file instead of the clicked tree item.
- Importing a large file no longer freezes the window.
- An error raised mid-batch no longer disables undo recording for the rest of the session.
- A storage path starting with `~` is expanded to the home directory. It used to be read as a relative path and land in a directory literally named `~` inside the workspace — including for the `~/.toudou/{workspace}.json` example this README recommends.

### Security

- Settings can no longer be imposed by a workspace. `toudou.defaultStoragePath` is now `machine`-scoped (user or remote settings, one value per machine since a path means something different on each); `toudou.defaultAddMode`, `toudou.watchExternalChanges` and `toudou.watchIntervalSeconds` are `application`-scoped (user settings only). None of them can come from a committed `.vscode/settings.json`. Previously a repository could point the storage file at an arbitrary absolute path, which was then written on activation. Overriding the path for one project still works through **Toudou: Set Workspace Storage Path**, which stores it outside the project. In a remote window the Settings editor lists this setting under the **Remote** tab.
- The absolute-path warning is shown whatever the setting it comes from, once per distinct path.
- The poll interval is validated before reaching `setInterval`, so a hand-edited value cannot turn the check into a busy loop.
- Temporary files are dot-prefixed, and the ones left behind by a window that died mid-write are swept at startup.

### Added

- External change detection: a filesystem watcher on the storage folder plus a periodic check of the file's mtime, needed because synced folders (Synology Drive, OneDrive…) emit no reliable watcher event. A change is only reported when the contents actually differ.
- New setting `toudou.watchExternalChanges` (default: `true`) to turn that off.
- New setting `toudou.watchIntervalSeconds` (`2` | `3` | `5` | `10`, default: `3`).
- New command "Reload Storage File" (`toudou.reloadStorage`) to force an immediate re-read.
- New command "Reset Storage Location" (`toudou.resetStorageLocation`), also in the view's `…` menu: forgets where the workspace stores its todos and asks again, without touching the file. The way out of a mistyped path, a synced folder that no longer exists, or a "Don't ask again" clicked too fast.
- The view's `…` menu now also carries "Set Workspace Storage Path" and "Reload Storage File", which were reachable from the Command Palette only.
- Toudou now asks where a workspace should keep its todos the first time its view is opened in a project that has none: create one in the workspace, choose a location and file name, reuse an existing file, or keep the invisible default. The answer is stored per workspace and outside the project, so cloning a repository can never decide where your todos are written. Only asked when there is nothing to lose — an existing list or a configured path means the choice is already made.

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
