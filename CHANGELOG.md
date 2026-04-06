# Changelog

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
