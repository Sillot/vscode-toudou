import * as vscode from 'vscode';
import { createCategory } from './models/category';
import { CompletedTodo, createTodo, Todo } from './models/todo';
import { HistoryProvider } from './providers/historyProvider';
import { TodoProvider } from './providers/todoProvider';
import * as storage from './services/storageService';
import { registerTodoTools } from './tools/todoTools';

export function activate(context: vscode.ExtensionContext): void {
  const todoProvider = new TodoProvider();
  const historyProvider = new HistoryProvider();

  const refreshAll = () => {
    todoProvider.refresh();
    historyProvider.refresh();
  };

  // Init storage then register everything
  storage.initStorage(context, refreshAll).then(() => {
    refreshAll();
  });

  const todoTreeView = vscode.window.createTreeView('toudouView', {
    treeDataProvider: todoProvider,
    dragAndDropController: todoProvider,
  });

  todoTreeView.onDidChangeCheckboxState(async (e) => {
    for (const [item] of e.items) {
      if ('title' in item && 'id' in item) {
        await storage.completeTodoById((item as Todo).id);
      }
    }
  });

  const historyTreeView = vscode.window.createTreeView('toudouHistoryView', {
    treeDataProvider: historyProvider,
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
    vscode.commands.registerCommand('toudou.completeTodo', () => completeTodoPalette()),
    vscode.commands.registerCommand('toudou.deleteTodo', () => deleteTodoPalette()),
    vscode.commands.registerCommand('toudou.addCategory', () => addCategoryFlow()),
    vscode.commands.registerCommand('toudou.renameCategory', () => renameCategoryPalette()),
    vscode.commands.registerCommand('toudou.deleteCategory', () => deleteCategoryPalette()),
    vscode.commands.registerCommand('toudou.restoreTodo', () => restoreTodoPalette()),
    vscode.commands.registerCommand('toudou.purgeHistory', () => purgeHistoryFlow()),
  );

  // --- Inline commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand('toudou.completeTodoInline', (todo: Todo) =>
      storage.completeTodoById(todo.id),
    ),
    vscode.commands.registerCommand('toudou.deleteTodoInline', (todo: Todo) =>
      storage.deleteTodo(todo.id),
    ),
    vscode.commands.registerCommand('toudou.editTodoTitle', (todo: Todo) => editTodoTitle(todo)),
    vscode.commands.registerCommand('toudou.editTodoDescription', (todo: Todo) =>
      editTodoDescription(todo),
    ),
    vscode.commands.registerCommand('toudou.changeTodoCategory', (todo: Todo) =>
      changeTodoCategory(todo),
    ),
    vscode.commands.registerCommand('toudou.copyTodoText', (todo?: Todo) => {
      const target = todo ?? todoTreeView.selection.find((s): s is Todo => 'title' in s);
      if (!target) return;
      const text = target.description ? `${target.title}\n${target.description}` : target.title;
      vscode.env.clipboard.writeText(text);
    }),
    vscode.commands.registerCommand('toudou.renameCategoryInline', (cat) =>
      renameCategoryInline(cat),
    ),
    vscode.commands.registerCommand('toudou.deleteCategoryInline', (cat) =>
      storage.deleteCategory(cat.id),
    ),
    vscode.commands.registerCommand('toudou.changeCategoryEmoji', (cat) =>
      changeCategoryEmoji(cat),
    ),
    vscode.commands.registerCommand('toudou.addTodoToCategory', (cat: { id: string }) =>
      addTodoToCategoryFlow(cat.id),
    ),
    vscode.commands.registerCommand('toudou.restoreTodoInline', (completed: CompletedTodo) =>
      storage.restoreFromHistory(completed.id),
    ),
  );

  // --- AI Tools ---
  registerTodoTools(context);
}

// --- Command implementations ---

async function addTodoFlow(): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Todo title'),
    placeHolder: vscode.l10n.t('What needs to be done?'),
    ignoreFocusOut: true,
  });
  if (!title) return;

  const categoryId = await pickOrCreateCategory();
  if (categoryId === null) return; // cancelled

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Description (optional)'),
    placeHolder: vscode.l10n.t('Press Enter to skip'),
    ignoreFocusOut: true,
  });

  const order = storage.getNextOrder(categoryId);
  await storage.addTodo(createTodo(title, categoryId, description || undefined, order));
}

async function addTodoToCategoryFlow(categoryId: string): Promise<void> {
  const title = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Todo title'),
    placeHolder: vscode.l10n.t('What needs to be done?'),
    ignoreFocusOut: true,
  });
  if (!title) return;

  const description = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Description (optional)'),
    placeHolder: vscode.l10n.t('Press Enter to skip'),
    ignoreFocusOut: true,
  });

  const order = storage.getNextOrder(categoryId);
  await storage.addTodo(createTodo(title, categoryId, description || undefined, order));
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
    });
    if (!name) return null;

    const existing = storage.getCategoryByName(name);
    if (existing) return existing.id;

    const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
    const cat = createCategory(name, maxOrder);
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
  const name = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Category name'),
    placeHolder: vscode.l10n.t('Enter category name...'),
    ignoreFocusOut: true,
  });
  if (!name) return;

  const existing = storage.getCategoryByName(name);
  if (existing) {
    vscode.window.showWarningMessage(vscode.l10n.t('Category "{0}" already exists.', name));
    return;
  }

  const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
  await storage.addCategory(createCategory(name, maxOrder));
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

  const newName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('New name'),
    value: pick.label,
    ignoreFocusOut: true,
  });
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
    vscode.window.showInformationMessage(vscode.l10n.t('History is empty.'));
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
    vscode.window.showInformationMessage(vscode.l10n.t('History is already empty.'));
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    vscode.l10n.t('Delete all {0} completed todo(s) from history?', history.length),
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
  });
  if (!newTitle || newTitle === todo.title) return;
  await storage.updateTodo(todo.id, { title: newTitle });
}

async function editTodoDescription(todo: Todo): Promise<void> {
  const newDesc = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Edit description'),
    value: todo.description ?? '',
    placeHolder: vscode.l10n.t('Leave empty to remove description'),
    ignoreFocusOut: true,
  });
  if (newDesc === undefined) return;
  await storage.updateTodo(todo.id, { description: newDesc || undefined });
}

async function changeTodoCategory(todo: Todo): Promise<void> {
  const categories = storage.getCategories();
  const items = categories.map((c) => ({
    label: c.name,
    id: c.id,
    picked: c.id === todo.categoryId,
  }));

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Select new category'),
    ignoreFocusOut: true,
  });
  if (!pick || pick.id === todo.categoryId) return;

  const order = storage.getNextOrder(pick.id);
  await storage.moveTodoToCategory(todo.id, pick.id, order);
}

async function renameCategoryInline(cat: { id: string; name: string }): Promise<void> {
  // Extract name from the tree item label which includes count
  const category = storage.getCategoryById(cat.id);
  if (!category) return;

  const newName = await vscode.window.showInputBox({
    prompt: vscode.l10n.t('Rename category'),
    value: category.name,
    ignoreFocusOut: true,
  });
  if (!newName || newName === category.name) return;
  await storage.renameCategory(cat.id, newName);
}

const EMOJI_OPTIONS = [
  '📋',
  '🚀',
  '🐛',
  '✨',
  '🔧',
  '📦',
  '🎨',
  '📝',
  '🔥',
  '💡',
  '⚡',
  '🧪',
  '📌',
  '🏷️',
  '💻',
  '🌐',
  '🔒',
  '📊',
  '🎯',
  '❤️',
  '⭐',
  '🏠',
  '📁',
  '🛠️',
  '🧩',
  '🎉',
  '⚙️',
  '📅',
  '🔔',
  '💬',
];

async function changeCategoryEmoji(cat: { id: string }): Promise<void> {
  const category = storage.getCategoryById(cat.id);
  if (!category) return;

  const items: vscode.QuickPickItem[] = [
    { label: '$(close) No emoji', description: 'Remove emoji' },
    ...EMOJI_OPTIONS.map((e) => ({ label: e })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Pick an emoji for "{0}"', category.name),
    ignoreFocusOut: true,
  });
  if (!pick) return;

  const emoji = pick.label.startsWith('$(close)') ? undefined : pick.label;
  await storage.updateCategoryEmoji(cat.id, emoji);
}

export function deactivate(): void {}
