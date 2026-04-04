# Spec Mapping — Source → Spec

Quick reference for which source files feed which spec files.

This list covers known spec files. If a new spec file is discovered in `specs/` that is not listed here, infer its source files from its content and headings.

## `specs/01-overview.md`

| Section | Source |
|---------|--------|
| Stack technique | `package.json` (dependencies, engines) |
| Structure de l'extension | Actual file tree under `src/` |
| Principes directeurs | Manual (rarely changes) |

## `specs/02-data-model.md`

| Section | Source |
|---------|--------|
| Category | `src/models/category.ts` → `Category` interface |
| Todo | `src/models/todo.ts` → `Todo` interface |
| CompletedTodo | `src/models/todo.ts` → `CompletedTodo` interface |
| TodoPriority | `src/models/todo.ts` → `TodoPriority` type |
| Constants | `src/models/todo.ts` → `PRIORITY_ORDER`, `NO_PRIORITY_ORDER` |
| StorageData | `src/services/storageService.ts` → `StorageData` interface |
| SortMode | `src/services/storageService.ts` → `SortMode` type |
| Fichier JSON structure | `src/services/storageService.ts` → `StorageData` |

## `specs/03-ui.md`

| Section | Source |
|---------|--------|
| Vue container | `package.json` → `contributes.viewsContainers`, `contributes.views` |
| Panneau Todos | `src/providers/todoProvider.ts` (TreeView structure, sort modes) |
| Panneau Historique | `src/providers/historyProvider.ts` |
| Actions barre de titre | `package.json` → `contributes.menus["view/title"]` |
| Actions inline | `package.json` → `contributes.menus["view/item/context"]` (group: inline) |
| Menu contextuel | `package.json` → `contributes.menus["view/item/context"]` (other groups) |
| Flow d'ajout | `src/extension.ts` → `addTodoFlow()` |
| Flow d'édition | `src/extension.ts` → `editTodoTitle()`, `editTodoDescription()`, etc. |

## `specs/04-commands.md`

| Section | Source |
|---------|--------|
| Palette de commandes | `package.json` → `contributes.commands` (visible ones) |
| Commandes internes | `package.json` → `contributes.menus.commandPalette` (when: false) |
| Command IDs | `src/extension.ts` → `registerCommand()` calls |

## `specs/05-ai-tools.md`

| Section | Source |
|---------|--------|
| Tools exposés | `src/tools/todoTools.ts` → `registerTodoTools()` |
| Paramètres | `src/tools/todoTools.ts` → `*Params` interfaces + `inputSchema` |
| Validation | `src/tools/todoTools.ts` → `MAX_*` constants |
| Comportement | `src/tools/todoTools.ts` → `invoke()` implementations |

## `specs/06-drag-and-drop.md`

| Section | Source |
|---------|--------|
| MIME type | `src/providers/todoProvider.ts` → `dragMimeTypes` |
| Réordonnement todos | `src/providers/todoProvider.ts` → `handleTodoDrop()` |
| Réordonnement catégories | `src/providers/todoProvider.ts` → `handleCategoryDrop()` |
| Règles | `src/providers/todoProvider.ts` → `handleDrop()` validation logic |
