# Toudou

<p align="center">
  <img src="resources/toudou_250px.png" alt="Toudou logo" width="250">
</p>

[![Version](https://img.shields.io/visual-studio-marketplace/v/Sillot.toudou)](https://marketplace.visualstudio.com/items?itemName=Sillot.toudou)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/Sillot.toudou)](https://marketplace.visualstudio.com/items?itemName=Sillot.toudou)
[![Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=Sillot.toudou)

A workspace-scoped todo list living right in your VS Code sidebar. Organize tasks with categories, priorities, drag & drop, and full undo/redo — no cloud, no account, everything stays local.

![Toudou](resources/toudou.png)

## Features

### Todos

- **Add, complete, delete and restore** todos from the sidebar or the Command Palette
- **Priorities** — high, medium, low — shown as inline labels and sortable
- **Descriptions** — optional details visible in tooltips
- **Checkbox integration** — check to complete, uncheck to restore
- **Double-click** a todo to rename it instantly

### Categories

- Create, rename, and delete categories
- Assign an **emoji** to each category
- Move todos between categories via the context menu or drag & drop

### Drag & Drop

- Reorder todos within a category
- Move todos between categories or to/from uncategorized
- Reorder categories themselves

### Sorting

Four sort modes available from the title bar:

| Mode                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| **Manual**              | Your own ordering via drag & drop              |
| **Priority**            | Flat list, highest priority first              |
| **Category**            | Grouped by category, manual order inside       |
| **Category + Priority** | Grouped by category, sorted by priority inside |

### History (Toudones)

Completed todos are moved to the **Toudones** panel where you can restore them individually or purge them all.

### Undo / Redo

Every action is undoable (up to 50 states). Keyboard shortcuts:

- **Undo**: `Ctrl+Z` / `Cmd+Z` (when panel is focused)
- **Redo**: `Ctrl+Shift+Z` / `Cmd+Shift+Z`

### Export / Import

- **Export** your todos (or a selection) to a JSON file
- **Import** from a JSON file — categories are auto-created as needed
- File size capped at 5 MB for safety

### Filter

Search todos by title or description in both panels.

### In Progress

Mark a todo as "in progress" — it gets a green icon to show what you're actively working on.

### Copilot Integration

Right-click a todo and select **Open in Copilot** to start a chat session with the task context pre-filled. The todo gets a green "in progress" icon while you work on it.

Six **Language Model Tools** are also registered so Copilot can create, list, complete, delete todos and manage categories on your behalf.

### Storage

- Data is stored **per workspace** in VS Code's `workspaceStorage` — never in your repo
- Configurable storage path via settings or per-workspace override
- Inspect the raw JSON anytime with **Toudou: Open Storage File**

### Localization

Fully translated in **English** and **French**. VS Code picks the right language automatically.

## Commands

All commands are available under the **Toudou** category in the Command Palette (`Ctrl+Shift+P`):

| Command                    | Description                                                |
| -------------------------- | ---------------------------------------------------------- |
| Add Todo                   | Create a new todo (with optional category and description) |
| Complete Todo              | Mark a todo as done                                        |
| Delete Todo                | Permanently remove a todo                                  |
| Create Category            | Add a new category                                         |
| Rename Category            | Rename an existing category                                |
| Delete Category            | Remove a category (todos become uncategorized)             |
| Restore from Toudones      | Bring back a completed todo                                |
| Purge Toudones             | Delete all completed todos                                 |
| Change Priority            | Set priority on a todo                                     |
| Filter Todos               | Search in the todo list                                    |
| Export Todos               | Export todos to a JSON file                                |
| Import Todos               | Import todos from a JSON file                              |
| Open Storage File          | View the raw JSON data                                     |
| Set Workspace Storage Path | Override the storage location for this workspace           |

## Settings

| Setting                     | Description                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `toudou.defaultStoragePath` | Default path to the storage file. Use `{workspace}` as a placeholder for the workspace name. |

By default, Toudou stores its data in VS Code's `workspaceStorage` directory, completely outside your project. You can override this with `toudou.defaultStoragePath`:

- **Relative path** — resolved from the workspace root (e.g. `.vscode/toudou.json`). Must stay inside the workspace.
- **Absolute path** — any location on disk (a warning is shown).
- **`{workspace}` placeholder** — replaced with a sanitized version of the workspace folder name (e.g. `~/.toudou/{workspace}.json`).

You can also set a **per-workspace** path via the command **Toudou: Set Workspace Storage Path**, which takes precedence over the global setting.

## Development

Open in VS Code with Dev Containers to get the full dockerized dev environment.

### Scripts

| Script              | Description                                            |
| ------------------- | ------------------------------------------------------ |
| `npm run compile`   | Build the extension                                    |
| `npm run watch`     | Build in watch mode                                    |
| `npm run typecheck` | Run TypeScript type checking                           |
| `npm run lint`      | Run ESLint                                             |
| `npm run format`    | Format with Prettier                                   |
| `npm run check`     | Run typecheck + lint + format check                    |
| `npm run package`   | Package as `.vsix` (runs check + minified build first) |

### Debug

Press `F5` to launch an Extension Development Host with the extension loaded.

## Contributing

Contributions are welcome! Whether it's a bug fix, a feature suggestion, or a documentation improvement — feel free to open an issue or submit a pull request.

## License

[MIT](LICENSE)
