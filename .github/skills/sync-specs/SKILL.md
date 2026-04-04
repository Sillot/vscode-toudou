---
name: sync-specs
description: "Synchronize specs from source code. Use when: code was modified and specs need updating, sync specs, update specs, spec out of date, spec drift, after implementing a feature, after refactoring."
argument-hint: "Optionally specify which spec files or source files to focus on"
---

# Sync Specs from Source Code

Update the specification files in `specs/` to accurately reflect the current implementation in `src/` and `package.json`.

**Direction: code → specs.** The specs document what IS implemented, not what SHOULD be.

## When to Use

- After implementing a new feature, command, or tool
- After refactoring that changes public interfaces, types, or behavior
- After adding/removing commands, menus, views, or configuration in `package.json`
- When asked to "sync specs", "update specs", or "mettre à jour les specs"
- As a final step after any multi-file code change

## Procedure

### Step 1 — Read the source of truth

Read ALL of the following files. Do not skip any:

1. `src/models/todo.ts` — Types `Todo`, `CompletedTodo`, `TodoPriority`, constants, factory functions
2. `src/models/category.ts` — Type `Category`, factory function
3. `src/services/storageService.ts` — Types `StorageData`, `SortMode`, all exported functions
4. `src/providers/todoProvider.ts` — TreeDataProvider behavior, sort modes, drag & drop
5. `src/providers/historyProvider.ts` — History TreeDataProvider behavior
6. `src/tools/todoTools.ts` — Language Model Tools, params, validation constants
7. `src/extension.ts` — All registered commands, flows, TreeView setup
8. `package.json` — `contributes` section: commands, views, menus, configuration

### Step 2 — Discover and read ALL spec files

List the `specs/` directory to discover all `*.md` files, then read every one of them. Do not assume a fixed list — new spec files may have been added.

### Step 3 — Compare and identify drift

Use the [spec mapping reference](./references/spec-mapping.md) to find the source files for each known spec. For any newly discovered spec file not listed in the mapping, infer the relevant source files from its content. For each spec file, identify:

- **Missing items**: things in source but not in spec (new fields, commands, tools, menu entries)
- **Outdated items**: things in spec that no longer match source (renamed fields, changed behavior, removed features)
- **Incorrect items**: details that are wrong (wrong types, wrong parameter names, wrong descriptions)

Do NOT flag stylistic differences or minor wording variations.

### Step 4 — Update spec files

For each spec file with drift:

1. **Preserve the existing structure, style, and formatting** of the spec file
2. **Add** missing items in the logical place (e.g., new fields in the table, new commands in the list)
3. **Update** outdated items to match the source
4. **Remove** items that no longer exist in the source
5. **Do not** rewrite sections that are already correct
6. **Do not** add implementation details — specs describe WHAT, not HOW

### Step 5 — Verify

After updating, do a final pass:

- Every type/interface field in source has a corresponding row in the data model spec
- Every command ID registered in `extension.ts` + `package.json` appears in the commands spec
- Every Language Model Tool in `todoTools.ts` is documented in the AI tools spec
- Every menu entry in `package.json` is reflected in the UI spec
- The structure diagram in the overview spec matches the actual file tree

### Scoped run (optional)

If the user specifies source files or spec files as argument, narrow the sync:

1. Read only the specified source files (+ always `package.json` for commands/menus)
2. Use the [spec mapping reference](./references/spec-mapping.md) to determine which spec files are impacted
3. Read and update only those spec files
4. Still run the verification step on the updated specs

## Rules

- **Language**: Specs are written in **French** (matching the existing convention)
- **Format**: Use Markdown tables for structured data, match existing table formats
- **No invention**: Only document what exists in code. Never add aspirational features
- **Minimal diff**: Change as little as possible to bring specs in sync. Don't reformat untouched sections
