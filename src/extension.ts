import * as vscode from 'vscode';
import { createCategory } from './models/category';
import { CompletedTodo, createTodo, duplicateTodo, Todo, TodoPriority } from './models/todo';
import { HistoryProvider } from './providers/historyProvider';
import { TodoProvider } from './providers/todoProvider';
import * as storage from './services/storageService';
import { initStorageWatcher, restartStorageWatcher } from './services/storageWatcher';
import { registerTodoTools } from './tools/todoTools';

const MAX_TITLE_LENGTH = 500;
const MAX_CATEGORY_LENGTH = 100;

export function activate(context: vscode.ExtensionContext): void {
  const todoProvider = new TodoProvider();
  const historyProvider = new HistoryProvider();

  const todoTreeView = vscode.window.createTreeView('toudouView', {
    treeDataProvider: todoProvider,
    dragAndDropController: todoProvider,
    canSelectMany: true,
  });

  const updateBadge = () => {
    const count = storage.getTodos().length;
    todoTreeView.badge =
      count > 0 ? { value: count, tooltip: vscode.l10n.t('{0} active todos', count) } : undefined;
  };

  const refreshAll = () => {
    todoProvider.refresh();
    historyProvider.refresh();
    updateBadge();
  };

  // Init storage then register everything. The catch matters: without it a
  // storage folder that cannot be created leaves the views unrefreshed and the
  // watcher unstarted, with nothing but an unhandled rejection to show for it.
  const initStorage = () =>
    storage
      .initStorage(context, refreshAll)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          vscode.l10n.t('Toudou: could not initialize storage. {0}', message),
        );
      })
      .finally(() => refreshAll());

  void initStorage().then(() => {
    initStorageWatcher(context, refreshAll);
    void promptForStorageLocation(context, refreshAll);
  });

  // Re-init storage when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('toudou.defaultStoragePath')) {
        void initStorage().then(() => restartStorageWatcher());
      } else if (
        e.affectsConfiguration('toudou.watchExternalChanges') ||
        e.affectsConfiguration('toudou.watchIntervalSeconds')
      ) {
        restartStorageWatcher();
      }
    }),
  );

  todoTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item] of e.items) {
      if ('title' in item && 'id' in item) {
        await storage.completeTodoById((item as Todo).id);
      }
    }
  });

  const historyTreeView = vscode.window.createTreeView('toudouHistoryView', {
    treeDataProvider: historyProvider,
    canSelectMany: true,
  });

  historyTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item] of e.items) {
      if ('id' in item) {
        await storage.restoreFromHistory((item as CompletedTodo).id);
      }
    }
  });

  context.subscriptions.push(todoTreeView, historyTreeView);

  // --- Palette commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('toudou.addTodo', () => addTodoFlow()),
    vscode.commands.registerCommand('toudou.addQuickTodo', () => addQuickTodoFlow()),
    vscode.commands.registerCommand('toudou.addTodoDefault', () => {
      const mode = vscode.workspace
        .getConfiguration('toudou')
        .get<string>('defaultAddMode', 'quick');
      return mode === 'complete' ? addTodoFlow() : addQuickTodoFlow();
    }),
    vscode.commands.registerCommand('toudou.completeTodo', () => completeTodoPalette()),
    vscode.commands.registerCommand('toudou.deleteTodo', () => deleteTodoPalette()),
    vscode.commands.registerCommand('toudou.addCategory', () => addCategoryFlow()),
    vscode.commands.registerCommand('toudou.renameCategory', () => renameCategoryPalette()),
    vscode.commands.registerCommand('toudou.deleteCategory', () => deleteCategoryPalette()),
    vscode.commands.registerCommand('toudou.restoreTodo', () => restoreTodoPalette()),
    vscode.commands.registerCommand('toudou.purgeHistory', () => purgeHistoryFlow()),
    vscode.commands.registerCommand('toudou.undo', () => storage.undo()),
    vscode.commands.registerCommand('toudou.redo', () => storage.redo()),
    vscode.commands.registerCommand(
      'toudou.exportTodos',
      async (
        item?: Todo | { id: string; name: string },
        selected?: (Todo | { id: string; name: string })[],
      ) => {
        const items = selected?.length
          ? selected
          : item
            ? [item]
            : (todoTreeView.selection as readonly (Todo | { id: string; name: string })[]);

        const todoIds: string[] = [];
        for (const it of items) {
          if ('title' in it) {
            todoIds.push(it.id);
          } else if ('name' in it) {
            for (const t of storage.getTodosByCategory(it.id)) {
              todoIds.push(t.id);
            }
          }
        }

        const exportData = storage.buildExportData(todoIds.length > 0 ? todoIds : undefined);

        if (exportData.todos.length === 0) {
          vscode.window.showInformationMessage(vscode.l10n.t('No todos to export.'));
          return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const defaultUri = workspaceFolder
          ? vscode.Uri.joinPath(workspaceFolder, 'toudou-export.json')
          : undefined;

        const uri = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { JSON: ['json'] },
        });
        if (!uri) return;

        const content = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
        await vscode.workspace.fs.writeFile(uri, content);
        vscode.window.showInformationMessage(
          vscode.l10n.t('{0} todo(s) exported.', exportData.todos.length),
        );
      },
    ),
    vscode.commands.registerCommand('toudou.importTodos', async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        openLabel: vscode.l10n.t('Import'),
      });
      if (!uris || uris.length === 0) return;

      const MAX_IMPORT_SIZE = 5 * 1024 * 1024; // 5 MB
      const stat = await vscode.workspace.fs.stat(uris[0]);
      if (stat.size > MAX_IMPORT_SIZE) {
        vscode.window.showErrorMessage(vscode.l10n.t('File too large (max 5 MB).'));
        return;
      }

      const raw = await vscode.workspace.fs.readFile(uris[0]);
      const text = Buffer.from(raw).toString('utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        vscode.window.showErrorMessage(vscode.l10n.t('Invalid JSON file.'));
        return;
      }

      const exportData = storage.parseExportData(parsed);
      if (!exportData) {
        vscode.window.showWarningMessage(vscode.l10n.t('No valid todos found in the file.'));
        return;
      }

      const count = await storage.importData(exportData);
      vscode.window.showInformationMessage(vscode.l10n.t('{0} todo(s) imported.', count));
    }),
  );

  // --- Inline commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('toudou.completeTodoInline', (todo: Todo) =>
      storage.completeTodoById(todo.id),
    ),
    vscode.commands.registerCommand(
      'toudou.deleteTodoInline',
      async (todo?: Todo, selected?: Todo[]) => {
        const todos = selected?.length
          ? selected
          : todo
            ? [todo]
            : todoTreeView.selection.filter((s): s is Todo => 'title' in s);
        storage.beginUndoBatch();
        try {
          for (const t of todos) {
            await storage.deleteTodo(t.id);
          }
        } finally {
          storage.endUndoBatch();
        }
      },
    ),
    vscode.commands.registerCommand('toudou.editTodoTitle', (todo: Todo) => editTodoTitle(todo)),
    vscode.commands.registerCommand('toudou.editTodoDescription', (todo: Todo) =>
      editTodoDescription(todo),
    ),
    vscode.commands.registerCommand('toudou.changeTodoCategory', (todo: Todo, selected?: Todo[]) =>
      changeTodoCategory(todo, selected),
    ),
    vscode.commands.registerCommand(
      'toudou.copyTodoText',
      (todoOrId?: Todo | string, selected?: Todo[]) => {
        let targets: Todo[];
        if (typeof todoOrId === 'string') {
          // Called from tooltip command link with todo ID
          const found = storage.getTodos().find((t) => t.id === todoOrId);
          targets = found ? [found] : [];
        } else {
          targets = selected?.length
            ? selected
            : todoOrId
              ? [todoOrId]
              : todoTreeView.selection.filter((s): s is Todo => 'title' in s);
        }
        if (targets.length === 0) return;
        const text = targets
          .map((t) => (t.description ? `${t.title}\n${t.description}` : t.title))
          .join('\n\n');
        vscode.env.clipboard.writeText(text);
      },
    ),
    vscode.commands.registerCommand('toudou.renameCategoryInline', (cat) =>
      renameCategoryInline(cat),
    ),
    vscode.commands.registerCommand(
      'toudou.deleteCategoryInline',
      async (cat: { id: string }, selected?: { id: string }[]) => {
        const cats = selected?.length ? selected : [cat];
        storage.beginUndoBatch();
        try {
          for (const c of cats) {
            await storage.deleteCategory(c.id);
          }
        } finally {
          storage.endUndoBatch();
        }
      },
    ),
    vscode.commands.registerCommand('toudou.changeCategoryEmoji', (cat) =>
      changeCategoryEmoji(cat),
    ),
    vscode.commands.registerCommand('toudou.addTodoToCategory', (cat: { id: string }) =>
      addTodoToCategoryFlow(cat.id),
    ),
    vscode.commands.registerCommand(
      'toudou.restoreTodoInline',
      async (completed: CompletedTodo, selected?: CompletedTodo[]) => {
        const items = selected?.length ? selected : [completed];
        storage.beginUndoBatch();
        try {
          for (const item of items) {
            await storage.restoreFromHistory(item.id);
          }
        } finally {
          storage.endUndoBatch();
        }
      },
    ),
    vscode.commands.registerCommand('toudou.sortByManual', () => storage.setSortMode('manual')),
    vscode.commands.registerCommand('toudou.sortByPriority', () => storage.setSortMode('priority')),
    vscode.commands.registerCommand('toudou.sortByCategory', () => storage.setSortMode('category')),
    vscode.commands.registerCommand('toudou.sortByCategoryPriority', () =>
      storage.setSortMode('categoryPriority'),
    ),
    vscode.commands.registerCommand('toudou.filterTodos', async () => {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Filter todos'),
        placeHolder: vscode.l10n.t('Type to filter by title or description...'),
        value: todoProvider.getFilter() ?? '',
        ignoreFocusOut: true,
      });
      if (value === undefined) return; // cancelled
      todoProvider.setFilter(value.trim() || undefined);
    }),
    vscode.commands.registerCommand('toudou.clearFilter', () => {
      todoProvider.setFilter(undefined);
    }),
    vscode.commands.registerCommand('toudou.filterHistory', async () => {
      const value = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('Filter toudones'),
        placeHolder: vscode.l10n.t('Type to filter by title or description...'),
        value: historyProvider.getFilter() ?? '',
        ignoreFocusOut: true,
      });
      if (value === undefined) return; // cancelled
      historyProvider.setFilter(value.trim() || undefined);
    }),
    vscode.commands.registerCommand('toudou.clearHistoryFilter', () => {
      historyProvider.setFilter(undefined);
    }),
    vscode.commands.registerCommand('toudou.changeTodoPriority', () => changeTodoPriorityPalette()),
    vscode.commands.registerCommand(
      'toudou.changeTodoPriorityInline',
      (todo: Todo, selected?: Todo[]) => changeTodoPriority(todo, selected),
    ),
    vscode.commands.registerCommand('toudou.openInCopilot', (todo: Todo, selected?: Todo[]) =>
      openTodoInCopilot(todo, selected),
    ),
    vscode.commands.registerCommand(
      'toudou.toggleInProgress',
      async (todo: Todo, selected?: Todo[]) => {
        const todos = selected?.length ? selected : [todo];
        storage.beginUndoBatch();
        try {
          for (const t of todos) {
            // The flag is flipped from the file, not from `t`: the tree item was
            // built before the storage re-read that precedes the write.
            await storage.toggleTodoInProgress(t.id);
          }
        } finally {
          storage.endUndoBatch();
        }
      },
    ),
    vscode.commands.registerCommand(
      'toudou.duplicateTodo',
      async (todo: Todo, selected?: Todo[]) => {
        if (!todo || typeof todo.id !== 'string') return;
        const todos = selected?.length ? selected : [todo];
        await duplicateTodoFlow(todos);
      },
    ),
    vscode.commands.registerCommand('toudou.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:Sillot.toudou'),
    ),
    vscode.commands.registerCommand('toudou.openStorageFile', () => {
      const uri = storage.getStorageFileUri();
      if (uri) {
        vscode.window.showTextDocument(uri);
      }
    }),
    vscode.commands.registerCommand('toudou.reloadStorage', async () => {
      const changed = await storage.reloadStorage();
      refreshAll();
      vscode.window.showInformationMessage(
        changed
          ? vscode.l10n.t('Storage file reloaded.')
          : vscode.l10n.t('Storage file is already up to date.'),
      );
    }),
    vscode.commands.registerCommand('toudou.setWorkspacePath', () =>
      setWorkspacePathFlow(context, refreshAll),
    ),
    vscode.commands.registerCommand('toudou.resetStorageLocation', () =>
      resetStorageLocationFlow(context, refreshAll),
    ),
    vscode.commands.registerCommand('toudou.deleteSelected', async () => {
      const selection = todoTreeView.selection;
      storage.beginUndoBatch();
      try {
        for (const item of selection) {
          if ('title' in item) {
            await storage.deleteTodo((item as Todo).id);
          } else if ('name' in item) {
            await storage.deleteCategory((item as { id: string }).id);
          }
        }
      } finally {
        storage.endUndoBatch();
      }
    }),
    vscode.commands.registerCommand('toudou.clickTodo', (todo: Todo) => handleTodoClick(todo)),
  );

  // --- AI Tools ---
  registerTodoTools(context);

  // --- Virtual filesystem for description editing ---
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(DESC_SCHEME, descriptionFs.provider),
  );
}

// --- Command implementations ---

const DESC_SCHEME = 'toudou-edit';

const descriptionFs = (() => {
  let content = new Uint8Array();
  const onDidChange = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const onSave = new vscode.EventEmitter<string>();

  const provider: vscode.FileSystemProvider & { onDidSave: vscode.Event<string> } = {
    onDidChangeFile: onDidChange.event,
    onDidSave: onSave.event,
    watch: () => ({ dispose() {} }),
    stat: () => ({
      type: vscode.FileType.File,
      ctime: 0,
      mtime: Date.now(),
      size: content.length,
    }),
    readDirectory: () => [],
    createDirectory: () => {},
    readFile: () => content,
    writeFile: (_uri, data) => {
      content = new Uint8Array(data);
      onSave.fire(new TextDecoder().decode(data));
    },
    delete: () => {},
    rename: () => {},
  };

  return {
    provider,
    setContent(text: string) {
      content = new TextEncoder().encode(text);
      onDidChange.fire([
        {
          type: vscode.FileChangeType.Changed,
          uri: vscode.Uri.parse(`${DESC_SCHEME}:/description.md`),
        },
      ]);
    },
  };
})();

/**
 * Opens a virtual Markdown editor for multi-line description input.
 * Ctrl+S = confirm. Close tab = cancel/skip.
 */
async function promptDescription(value: string | undefined): Promise<string | undefined | null> {
  const uri = vscode.Uri.parse(`${DESC_SCHEME}:/description.md`);
  descriptionFs.setContent(value ?? '');

  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });

  return new Promise<string | undefined | null>((resolve) => {
    let resolved = false;
    const disposables: vscode.Disposable[] = [];

    function finish(result: string | undefined | null) {
      if (resolved) return;
      resolved = true;
      disposables.forEach((d) => d.dispose());
      resolve(result);
    }

    // Ctrl+S = confirm
    disposables.push(
      descriptionFs.provider.onDidSave(async (text) => {
        const trimmed = text.trim();
        finish(trimmed || undefined);
        // Revert (clears dirty state) then close the tab
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            if (
              tab.input instanceof vscode.TabInputText &&
              tab.input.uri.toString() === uri.toString()
            ) {
              await vscode.window.showTextDocument(doc, { preserveFocus: false });
              await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
              return;
            }
          }
        }
      }),
    );

    // Close tab = cancel
    disposables.push(
      vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (closedDoc.uri.toString() === uri.toString()) {
          finish(null);
        }
      }),
    );
  });
}

async function addTodoFlow(): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Todo title'),
    placeHolder: vscode.l10n.t('What needs to be done?'),
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_TITLE_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_TITLE_LENGTH)
        : undefined,
  });
  if (!title) return;

  const categoryId = await pickOrCreateCategory();
  if (categoryId === null) return; // cancelled

  const descResult = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Description (optional)'),
    placeHolder: vscode.l10n.t('Press Enter to skip'),
    ignoreFocusOut: true,
  });
  const description = descResult?.trim() || undefined;

  const order = storage.getNextOrder(categoryId);
  await storage.addTodo(createTodo(title, categoryId, description, order));
}

async function addTodoToCategoryFlow(categoryId: string): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Todo title'),
    placeHolder: vscode.l10n.t('What needs to be done?'),
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_TITLE_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_TITLE_LENGTH)
        : undefined,
  });
  if (!title) return;

  const descResult = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Description (optional)'),
    placeHolder: vscode.l10n.t('Press Enter to skip'),
    ignoreFocusOut: true,
  });
  const description = descResult?.trim() || undefined;

  const order = storage.getNextOrder(categoryId);
  await storage.addTodo(createTodo(title, categoryId, description, order));
}

async function addQuickTodoFlow(): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Todo title'),
    placeHolder: vscode.l10n.t('What needs to be done?'),
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_TITLE_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_TITLE_LENGTH)
        : undefined,
  });
  if (!title) return;

  const order = storage.getNextOrder(undefined);
  await storage.addTodo(createTodo(title, undefined, undefined, order));
}

async function pickOrCreateCategory(): Promise<string | undefined | null> {
  interface CategoryPickItem extends vscode.QuickPickItem {
    categoryId?: string;
  }

  const categories = storage.getCategories();
  const items: CategoryPickItem[] = [
    { label: vscode.l10n.t('No category'), description: vscode.l10n.t('Add to top-level') },
    {
      label: vscode.l10n.t('$(add) New category...'),
      description: vscode.l10n.t('Create a new category'),
    },
    ...categories.map((c) => ({ label: c.name, categoryId: c.id })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select a category'),
    ignoreFocusOut: true,
  });
  if (!pick) return null; // cancelled

  if (pick.label === vscode.l10n.t('No category')) {
    return undefined; // uncategorized
  }

  if (pick.label.startsWith('$(add)')) {
    const name = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Category name'),
      placeHolder: vscode.l10n.t('Enter category name...'),
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.length > MAX_CATEGORY_LENGTH
          ? vscode.l10n.t('Too long (max {0} characters)', MAX_CATEGORY_LENGTH)
          : undefined,
    });
    if (!name) return null;

    const existing = storage.getCategoryByName(name);
    if (existing) return existing.id;

    const cat = createCategory(name, storage.getNextCategoryOrder());
    await storage.addCategory(cat);
    return cat.id;
  }

  return pick.categoryId;
}

async function completeTodoPalette(): Promise<void> {
  const todo = await pickTodo(vscode.l10n.t('Select a todo to complete'));
  if (!todo) return;
  await storage.completeTodoById(todo.id);
}

async function deleteTodoPalette(): Promise<void> {
  const todo = await pickTodo(vscode.l10n.t('Select a todo to delete'));
  if (!todo) return;
  await storage.deleteTodo(todo.id);
}

async function pickTodo(placeholder: string): Promise<Todo | undefined> {
  const todos = storage.getTodos();
  if (todos.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No todos found.'));
    return undefined;
  }

  const categories = storage.getCategories();
  const items = todos.map((t) => {
    const cat = categories.find((c) => c.id === t.categoryId);
    return {
      label: t.title,
      description: cat?.name ?? vscode.l10n.t('Uncategorized'),
      todo: t,
    };
  });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    ignoreFocusOut: true,
  });
  return pick?.todo;
}

async function addCategoryFlow(): Promise<void> {
  const rawName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Category name'),
    placeHolder: vscode.l10n.t('Enter category name...'),
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_CATEGORY_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_CATEGORY_LENGTH)
        : undefined,
  });
  const name = rawName?.trim();
  if (!name) return;

  const existing = storage.getCategoryByName(name);
  if (existing) {
    vscode.window.showWarningMessage(vscode.l10n.t('Category "{0}" already exists.', name));
    return;
  }

  await storage.addCategory(createCategory(name, storage.getNextCategoryOrder()));
}

async function renameCategoryPalette(): Promise<void> {
  const categories = storage.getCategories();
  if (categories.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No categories to rename.'));
    return;
  }

  const pick = await vscode.window.showQuickPick(
    categories.map((c) => ({ label: c.name, id: c.id })),
    { placeHolder: vscode.l10n.t('Select a category to rename'), ignoreFocusOut: true },
  );
  if (!pick) return;

  const rawName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New name'),
    value: pick.label,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_CATEGORY_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_CATEGORY_LENGTH)
        : undefined,
  });
  const newName = rawName?.trim();
  if (!newName || newName === pick.label) return;

  await storage.renameCategory(pick.id, newName);
}

async function deleteCategoryPalette(): Promise<void> {
  const categories = storage.getCategories();
  if (categories.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('No categories to delete.'));
    return;
  }

  const pick = await vscode.window.showQuickPick(
    categories.map((c) => ({ label: c.name, id: c.id })),
    {
      placeHolder: vscode.l10n.t('Select a category to delete (todos become uncategorized)'),
      ignoreFocusOut: true,
    },
  );
  if (!pick) return;

  await storage.deleteCategory(pick.id);
}

async function restoreTodoPalette(): Promise<void> {
  const history = storage.getHistory();
  if (history.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('Toudones is empty.'));
    return;
  }

  const items = history.map((h) => ({
    label: h.title,
    description: vscode.l10n.t('completed {0}', new Date(h.completedAt).toLocaleDateString()),
    id: h.id,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select a todo to restore'),
    ignoreFocusOut: true,
  });
  if (!pick) return;

  await storage.restoreFromHistory(pick.id);
}

async function purgeHistoryFlow(): Promise<void> {
  const history = storage.getHistory();
  if (history.length === 0) {
    vscode.window.showInformationMessage(vscode.l10n.t('Toudones is already empty.'));
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete all {0} completed todo(s) from Toudones?', history.length),
    { modal: true },
    vscode.l10n.t('Purge'),
  );
  if (confirm !== vscode.l10n.t('Purge')) return;

  await storage.purgeHistory();
}

async function editTodoTitle(todo: Todo): Promise<void> {
  const newTitle = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Edit title'),
    value: todo.title,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_TITLE_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_TITLE_LENGTH)
        : undefined,
  });
  if (!newTitle || newTitle === todo.title) return;
  await storage.updateTodo(todo.id, { title: newTitle });
}

async function editTodoDescription(todo: Todo): Promise<void> {
  const result = await promptDescription(todo.description);
  if (result === null) return;
  await storage.updateTodo(todo.id, { description: result });
}

async function changeTodoCategory(todo: Todo, selected?: Todo[]): Promise<void> {
  const todos = selected?.length ? selected : [todo];
  const categories = storage.getCategories();
  const items = categories.map((c) => ({
    label: c.name,
    id: c.id,
    picked: todos.length === 1 ? c.id === todos[0].categoryId : false,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select new category'),
    ignoreFocusOut: true,
  });
  if (!pick) return;

  storage.beginUndoBatch();
  try {
    for (const t of todos) {
      if (t.categoryId !== pick.id) {
        // No target todo: appended to the end of the category, positioned
        // against the file's current contents rather than this stale list.
        await storage.moveTodoBefore(t.id, pick.id, undefined);
      }
    }
  } finally {
    storage.endUndoBatch();
  }
}

async function duplicateTodoFlow(todos: Todo[]): Promise<void> {
  const categoryId = await pickOrCreateCategory();
  if (categoryId === null) return; // cancelled

  storage.beginUndoBatch();
  try {
    for (const todo of todos) {
      const order = storage.getNextOrder(categoryId);
      await storage.addTodo(
        duplicateTodo({ ...todo, title: todo.title.slice(0, MAX_TITLE_LENGTH) }, categoryId, order),
      );
    }
  } finally {
    storage.endUndoBatch();
  }
}

async function renameCategoryInline(cat: { id: string; name: string }): Promise<void> {
  // Extract name from the tree item label which includes count
  const category = storage.getCategoryById(cat.id);
  if (!category) return;

  const rawName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Rename category'),
    value: category.name,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v.length > MAX_CATEGORY_LENGTH
        ? vscode.l10n.t('Too long (max {0} characters)', MAX_CATEGORY_LENGTH)
        : undefined,
  });
  const newName = rawName?.trim();
  if (!newName || newName === category.name) return;
  await storage.renameCategory(cat.id, newName);
}

interface EmojiPickItem extends vscode.QuickPickItem {
  emoji?: string;
  action?: 'remove' | 'custom';
}

const EMOJI_CATALOG: {
  group: string;
  emojis: { emoji: string; label: string; keywords: string }[];
}[] = [
  {
    group: 'Development',
    emojis: [
      { emoji: '🐛', label: 'Bug', keywords: 'fix, issue, debug, error' },
      { emoji: '✨', label: 'Feature', keywords: 'sparkles, new, enhancement' },
      { emoji: '🔧', label: 'Fix', keywords: 'wrench, repair, tool, patch' },
      { emoji: '🚀', label: 'Deploy', keywords: 'rocket, launch, ship, release' },
      { emoji: '📦', label: 'Package', keywords: 'box, module, dependency, npm' },
      { emoji: '🎨', label: 'Style', keywords: 'art, design, palette, ui, css' },
      { emoji: '♻️', label: 'Refactor', keywords: 'recycle, clean, rewrite' },
      { emoji: '🧪', label: 'Test', keywords: 'lab, experiment, testing, qa' },
      { emoji: '💻', label: 'Code', keywords: 'laptop, computer, dev' },
      { emoji: '⚙️', label: 'Config', keywords: 'gear, settings, configuration' },
      { emoji: '🛠️', label: 'Tools', keywords: 'hammer, wrench, build' },
      { emoji: '🧩', label: 'Plugin', keywords: 'puzzle, extension, module, addon' },
      { emoji: '🔍', label: 'Search', keywords: 'magnifier, find, inspect, review' },
      { emoji: '🧹', label: 'Cleanup', keywords: 'broom, sweep, chore, tech debt' },
      { emoji: '🔀', label: 'Merge', keywords: 'branch, git, pr, pull request' },
      { emoji: '🏷️', label: 'Version', keywords: 'tag, release, semver, changelog' },
    ],
  },
  {
    group: 'Tasks & Planning',
    emojis: [
      { emoji: '📋', label: 'Clipboard', keywords: 'list, tasks, board, backlog' },
      { emoji: '📝', label: 'Memo', keywords: 'note, write, document' },
      { emoji: '📌', label: 'Pin', keywords: 'pushpin, important, pinned' },
      { emoji: '📅', label: 'Calendar', keywords: 'date, schedule, plan, deadline' },
      { emoji: '🎯', label: 'Target', keywords: 'goal, bullseye, aim, focus, objective' },
      { emoji: '🔔', label: 'Bell', keywords: 'notification, alert, reminder' },
      { emoji: '💬', label: 'Chat', keywords: 'comment, message, speech, discussion' },
      { emoji: '📧', label: 'Email', keywords: 'mail, inbox, message, send' },
      { emoji: '📣', label: 'Megaphone', keywords: 'announce, broadcast, communication' },
      { emoji: '🗓️', label: 'Planner', keywords: 'schedule, sprint, agenda, iteration' },
      { emoji: '📎', label: 'Paperclip', keywords: 'attach, link, reference' },
      { emoji: '✏️', label: 'Pencil', keywords: 'edit, write, draft, wip' },
    ],
  },
  {
    group: 'Status & Priority',
    emojis: [
      { emoji: '🔥', label: 'Fire', keywords: 'hot, urgent, critical, breaking' },
      { emoji: '⚡', label: 'Zap', keywords: 'lightning, fast, performance, speed' },
      { emoji: '💡', label: 'Idea', keywords: 'lightbulb, tip, insight, suggestion' },
      { emoji: '⚠️', label: 'Warning', keywords: 'alert, caution, attention, danger' },
      { emoji: '🚧', label: 'WIP', keywords: 'construction, in progress, building' },
      { emoji: '🔒', label: 'Lock', keywords: 'security, locked, private, auth' },
      { emoji: '✅', label: 'Done', keywords: 'check, complete, finished, validated' },
      { emoji: '❌', label: 'Blocked', keywords: 'cross, cancel, rejected, stopped' },
      { emoji: '⏳', label: 'Hourglass', keywords: 'waiting, pending, time, later' },
      { emoji: '🔄', label: 'Refresh', keywords: 'sync, update, reload, recurring' },
      { emoji: '🚫', label: 'Forbidden', keywords: 'no, prohibited, blocked, deprecated' },
      { emoji: '💤', label: 'Sleeping', keywords: 'zzz, paused, idle, on hold, dormant' },
    ],
  },
  {
    group: 'Data & Infrastructure',
    emojis: [
      { emoji: '📊', label: 'Chart', keywords: 'stats, analytics, data, graph, metrics' },
      { emoji: '🌐', label: 'Globe', keywords: 'web, internet, i18n, network, api' },
      { emoji: '📁', label: 'Folder', keywords: 'directory, files, storage' },
      { emoji: '🗄️', label: 'Database', keywords: 'cabinet, storage, db, sql' },
      { emoji: '☁️', label: 'Cloud', keywords: 'hosting, server, saas, infra' },
      { emoji: '🖥️', label: 'Desktop', keywords: 'monitor, screen, frontend, app' },
      { emoji: '📡', label: 'Satellite', keywords: 'antenna, signal, streaming, realtime' },
      { emoji: '🔗', label: 'Link', keywords: 'chain, url, connection, reference' },
      { emoji: '🐳', label: 'Whale', keywords: 'docker, container, devops' },
      { emoji: '📈', label: 'Trending up', keywords: 'growth, progress, improvement, kpi' },
      { emoji: '📉', label: 'Trending down', keywords: 'decline, regression, issue' },
    ],
  },
  {
    group: 'People & Roles',
    emojis: [
      { emoji: '👤', label: 'User', keywords: 'person, profile, account, customer' },
      { emoji: '👥', label: 'Team', keywords: 'people, group, collaboration, crew' },
      { emoji: '🧑‍💻', label: 'Developer', keywords: 'technologist, coder, programmer, engineer' },
      { emoji: '🎓', label: 'Learning', keywords: 'graduation, education, training, onboarding' },
      { emoji: '🤝', label: 'Handshake', keywords: 'partnership, agreement, contract, deal' },
      { emoji: '💼', label: 'Business', keywords: 'briefcase, work, corporate, client' },
    ],
  },
  {
    group: 'Symbols & Misc',
    emojis: [
      { emoji: '⭐', label: 'Star', keywords: 'favorite, bookmark, important' },
      { emoji: '❤️', label: 'Heart', keywords: 'love, favorite, core, health' },
      { emoji: '💎', label: 'Gem', keywords: 'diamond, premium, quality, value' },
      { emoji: '🎉', label: 'Party', keywords: 'tada, celebration, launch, done, ship' },
      { emoji: '🏠', label: 'Home', keywords: 'house, main, homepage' },
      { emoji: '📚', label: 'Books', keywords: 'docs, documentation, library, learn, wiki' },
      { emoji: '🔑', label: 'Key', keywords: 'password, secret, access, auth, credential' },
      { emoji: '🏗️', label: 'Building', keywords: 'architecture, structure, foundation' },
      { emoji: '🏆', label: 'Trophy', keywords: 'winner, award, achievement, milestone' },
      { emoji: '🎮', label: 'Gamepad', keywords: 'game, gaming, fun, play' },
      { emoji: '🎵', label: 'Music', keywords: 'audio, sound, media, player' },
      { emoji: '🖼️', label: 'Frame', keywords: 'image, picture, photo, media, gallery' },
      { emoji: '💰', label: 'Money', keywords: 'bag, finance, billing, payment, revenue' },
      { emoji: '🌱', label: 'Seedling', keywords: 'growth, new, green, eco, sustainability' },
      { emoji: '🌙', label: 'Moon', keywords: 'night, dark mode, sleep, theme' },
      { emoji: '☀️', label: 'Sun', keywords: 'light, bright, day, energy' },
      { emoji: '🧭', label: 'Compass', keywords: 'navigation, direction, explore, roadmap' },
      { emoji: '🪄', label: 'Magic wand', keywords: 'wizard, auto, generate, transform' },
      { emoji: '🦄', label: 'Unicorn', keywords: 'rare, unique, special, fantasy' },
      { emoji: '🐙', label: 'Octopus', keywords: 'github, tentacle, multi' },
    ],
  },
];

async function changeCategoryEmoji(cat: { id: string }): Promise<void> {
  const category = storage.getCategoryById(cat.id);
  if (!category) return;

  const items: EmojiPickItem[] = [
    {
      label: `$(close) ${vscode.l10n.t('No emoji')}`,
      description: vscode.l10n.t('Remove emoji'),
      action: 'remove',
    },
    {
      label: `$(pencil) ${vscode.l10n.t('Custom emoji…')}`,
      description: vscode.l10n.t('Type or paste any emoji'),
      action: 'custom',
    },
    ...EMOJI_CATALOG.flatMap((group) => [
      { label: group.group, kind: vscode.QuickPickItemKind.Separator } as EmojiPickItem,
      ...group.emojis.map((e) => ({
        label: `${e.emoji} ${e.label}`,
        description:
          e.emoji === category.emoji ? `${vscode.l10n.t('(current)')} · ${e.keywords}` : e.keywords,
        emoji: e.emoji,
      })),
    ]),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Pick an emoji for "{0}"', category.name),
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!pick) return;

  if (pick.action === 'custom') {
    const input = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Type or paste an emoji'),
      ignoreFocusOut: true,
    });
    if (input === undefined || !input.trim()) return;
    await storage.updateCategoryEmoji(cat.id, input.trim());
    return;
  }

  const emoji = pick.action === 'remove' ? undefined : pick.emoji;
  await storage.updateCategoryEmoji(cat.id, emoji);
}

const PRIORITY_PICK_LABELS: { label: string; priority: TodoPriority | undefined }[] = [
  { label: '⬆ High', priority: 'high' },
  { label: '● Medium', priority: 'medium' },
  { label: '⬇ Low', priority: 'low' },
  { label: '$(close) None', priority: undefined },
];

async function changeTodoPriority(todo: Todo, selected?: Todo[]): Promise<void> {
  const todos = selected?.length ? selected : [todo];
  const items = PRIORITY_PICK_LABELS.map((p) => ({
    label: p.label,
    description:
      todos.length === 1 && todos[0].priority === p.priority
        ? vscode.l10n.t('(current)')
        : undefined,
    priority: p.priority,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder:
      todos.length === 1
        ? vscode.l10n.t('Select priority for "{0}"', todos[0].title)
        : vscode.l10n.t('Select priority'),
    ignoreFocusOut: true,
  });
  if (!pick) return;

  storage.beginUndoBatch();
  for (const t of todos) {
    await storage.setTodoPriority(t.id, pick.priority);
  }
  storage.endUndoBatch();
}

async function changeTodoPriorityPalette(): Promise<void> {
  const todo = await pickTodo(vscode.l10n.t('Select a todo to change priority'));
  if (!todo) return;
  await changeTodoPriority(todo);
}

async function openTodoInCopilot(todo: Todo, selected?: Todo[]): Promise<void> {
  const todos = selected?.length ? selected : [todo];

  storage.beginUndoBatch();
  try {
    for (const t of todos) {
      if (!t.inProgress) {
        await storage.setTodoInProgress(t.id, true);
      }
    }
  } finally {
    storage.endUndoBatch();
  }

  const todosText = todos
    .map((t) => {
      const parts = [`Task: ${t.title}`];
      if (t.description) {
        parts.push(`Description: ${t.description}`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  const message = `Work on the following todo(s) from my Toudou list:\n\n---\n${todosText}\n---`;

  await vscode.commands.executeCommand('workbench.action.chat.open', { query: message });
}

// --- Storage location ---

const STORAGE_PROMPT_KEY = 'storageLocationAsked';
const DEFAULT_WORKSPACE_STORAGE = '.vscode/toudou.json';

async function applyChosenStoragePath(path: string, refreshAll: () => void): Promise<void> {
  // The user picked this location in a dialog: warning them about it right
  // afterwards would be noise.
  storage.acknowledgeStoragePath(path);
  await storage.setWorkspaceStoragePath(path);
  restartStorageWatcher();
  refreshAll();
}

/** Save dialog: pick both the folder and the file name. */
function pickNewStorageFile(base: vscode.Uri): Thenable<vscode.Uri | undefined> {
  return vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(base, 'toudou.json'),
    filters: { JSON: ['json'] },
    saveLabel: vscode.l10n.t('Use this file'),
    title: vscode.l10n.t('Choose where Toudou stores this workspace'),
  });
}

/** Open dialog: reuse a file that already exists, typically shared with Obsidian. */
async function pickExistingStorageFile(base: vscode.Uri): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    defaultUri: base,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { JSON: ['json'] },
    openLabel: vscode.l10n.t('Use this file'),
    title: vscode.l10n.t('Select an existing Toudou storage file'),
  });
  return picked?.[0];
}

/** The typed form, the only one that accepts `{workspace}` and `~`. */
async function promptForStoragePathText(current: string | undefined): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: vscode.l10n.t(
      'Storage file path for this workspace (absolute or relative to workspace root)',
    ),
    placeHolder: vscode.l10n.t('e.g. .vscode/toudou.json or leave empty to reset'),
    value: current ?? '',
    ignoreFocusOut: true,
  });
}

type StorageAction = 'workspace' | 'choose' | 'existing' | 'type' | 'reset';

/**
 * The storage location, changeable at any time rather than only on first use.
 *
 * Reached from the view's `…` menu: moving a project's todos into a synced
 * folder, or onto the file Obsidian already writes, is a thing people decide
 * long after opening the project for the first time.
 */
async function setWorkspacePathFlow(
  context: vscode.ExtensionContext,
  refreshAll: () => void,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage(
      vscode.l10n.t('Toudou: open a folder first — there is no workspace to store todos for.'),
    );
    return;
  }

  const override = storage.getWorkspaceStoragePath();
  const current = storage.getStorageFileUri()?.fsPath;

  // Icons stay out of the translated strings, which are the same ones the
  // first-run notification uses.
  const items: (vscode.QuickPickItem & { action: StorageAction })[] = [
    {
      label: `$(new-file) ${vscode.l10n.t('Create in workspace')}`,
      description: DEFAULT_WORKSPACE_STORAGE,
      action: 'workspace',
    },
    {
      label: `$(save-as) ${vscode.l10n.t('Choose location…')}`,
      description: vscode.l10n.t('pick a folder and a file name'),
      action: 'choose',
    },
    {
      label: `$(folder-opened) ${vscode.l10n.t('Use an existing file…')}`,
      description: vscode.l10n.t('a file shared with Obsidian or another window'),
      action: 'existing',
    },
    {
      label: `$(edit) ${vscode.l10n.t('Enter a path…')}`,
      // Passed as an argument: `l10n.t` would read a literal {workspace} as one
      // of its own placeholders.
      description: vscode.l10n.t('supports {0} and ~', '{workspace}'),
      action: 'type',
    },
  ];
  if (override) {
    items.push({
      label: `$(discard) ${vscode.l10n.t('Reset to default')}`,
      description: vscode.l10n.t('back to the location this machine uses'),
      action: 'reset',
    });
  }

  const pick = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Toudou storage for this workspace'),
    placeHolder: current
      ? vscode.l10n.t('Currently: {0}', current)
      : vscode.l10n.t('No storage file yet'),
    ignoreFocusOut: true,
  });
  if (!pick) return;

  // Whatever they answer here is an answer: the first-run question has served
  // its purpose and must not come back.
  const remember = () => context.workspaceState.update(STORAGE_PROMPT_KEY, true);

  switch (pick.action) {
    case 'workspace':
      await applyChosenStoragePath(DEFAULT_WORKSPACE_STORAGE, refreshAll);
      await remember();
      return;

    case 'choose': {
      const target = await pickNewStorageFile(folders[0].uri);
      if (!target) return;
      await applyChosenStoragePath(target.fsPath, refreshAll);
      await remember();
      return;
    }

    case 'existing': {
      const target = await pickExistingStorageFile(folders[0].uri);
      if (!target) return;
      await applyChosenStoragePath(target.fsPath, refreshAll);
      await remember();
      return;
    }

    case 'type': {
      const typed = await promptForStoragePathText(override);
      if (typed === undefined) return;
      await storage.setWorkspaceStoragePath(typed || undefined);
      restartStorageWatcher();
      refreshAll();
      await remember();
      return;
    }

    case 'reset':
      await resetStorageLocationFlow(context, refreshAll, false);
      return;
  }
}

/**
 * Offers a storage location the first time the view is opened in a workspace.
 *
 * Without it the file is created in VS Code's private `workspaceStorage`, which
 * works but is invisible — and invisible is the wrong default for a file meant
 * to be shared with Obsidian or committed alongside the project. Asked once, and
 * only when there is nothing to lose: an existing list or an already configured
 * path means the choice has been made.
 */
async function promptForStorageLocation(
  context: vscode.ExtensionContext,
  refreshAll: () => void,
  force = false,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    if (force) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('Toudou: open a folder first — there is no workspace to store todos for.'),
      );
    }
    return;
  }

  // Every gate below is about not interrupting someone who never asked. When the
  // question is the point of the command, they all go.
  if (!force) {
    if (context.workspaceState.get<boolean>(STORAGE_PROMPT_KEY)) return;
    if (storage.getWorkspaceStoragePath()) return;
    if (vscode.workspace.getConfiguration('toudou').get<string>('defaultStoragePath')) return;

    const isEmpty =
      storage.getTodos().length === 0 &&
      storage.getCategories().length === 0 &&
      storage.getHistory().length === 0;
    if (!isEmpty) return;
  }

  const createHere = vscode.l10n.t('Create in workspace');
  const chooseLocation = vscode.l10n.t('Choose location…');
  const openExisting = vscode.l10n.t('Use an existing file…');
  const never = vscode.l10n.t("Don't ask again");

  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Toudou: where should this workspace keep its todos?'),
    createHere,
    chooseLocation,
    openExisting,
    never,
  );
  // Dismissed, or auto-hidden after a few seconds — not an answer. Asking again
  // next time is the friendlier reading.
  if (choice === undefined) return;

  const remember = () => context.workspaceState.update(STORAGE_PROMPT_KEY, true);

  if (choice === createHere) {
    await applyChosenStoragePath(DEFAULT_WORKSPACE_STORAGE, refreshAll);
    await remember();
    return;
  }

  if (choice === chooseLocation) {
    const target = await pickNewStorageFile(folders[0].uri);
    if (!target) return; // cancelled: leave the question open
    await applyChosenStoragePath(target.fsPath, refreshAll);
    await remember();
    return;
  }

  if (choice === openExisting) {
    const target = await pickExistingStorageFile(folders[0].uri);
    if (!target) return;
    await applyChosenStoragePath(target.fsPath, refreshAll);
    await remember();
    return;
  }

  await remember();
}

/**
 * Forgets where this workspace stores its todos and asks again.
 *
 * The escape hatch for every dead end the choice can lead to: a path typed with
 * a typo, a synced folder that no longer exists, "Don't ask again" clicked too
 * fast. Nothing on disk is touched — only the pointer to it.
 */
async function resetStorageLocationFlow(
  context: vscode.ExtensionContext,
  refreshAll: () => void,
  reprompt = true,
): Promise<void> {
  const current = storage.getWorkspaceStoragePath() ?? storage.getStorageFileUri()?.fsPath;

  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Forget where this workspace stores its todos?'),
    {
      modal: true,
      detail: current
        ? vscode.l10n.t(
            'Toudou will stop using "{0}" and ask again where to store this workspace. The file itself is left untouched.',
            current,
          )
        : vscode.l10n.t('Toudou will ask again where to store this workspace. No file is deleted.'),
    },
    vscode.l10n.t('Forget'),
  );
  if (confirm === undefined) return;

  await context.workspaceState.update(STORAGE_PROMPT_KEY, undefined);
  await storage.setWorkspaceStoragePath(undefined);
  restartStorageWatcher();
  refreshAll();

  // Skipped when this came from the picker: they have just been offered every
  // option, so throwing the same question back at them would be a loop.
  if (reprompt) await promptForStorageLocation(context, refreshAll, true);
}

// --- Double-click detection ---

let lastClickedTodoId: string | undefined;
let lastClickTime = 0;
const DOUBLE_CLICK_THRESHOLD = 400;

function handleTodoClick(todo: Todo): void {
  const now = Date.now();
  if (lastClickedTodoId === todo.id && now - lastClickTime < DOUBLE_CLICK_THRESHOLD) {
    lastClickedTodoId = undefined;
    lastClickTime = 0;
    editTodoTitle(todo);
  } else {
    lastClickedTodoId = todo.id;
    lastClickTime = now;
  }
}

export function deactivate(): void {}
