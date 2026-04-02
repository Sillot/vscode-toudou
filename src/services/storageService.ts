import * as vscode from 'vscode';
import { Category } from '../models/category';
import { Todo, CompletedTodo } from '../models/todo';

const FILE_NAME = 'toudou.json';
const LEGACY_STORAGE_KEY = 'toudou.todos';

interface StorageData {
  categories: Category[];
  todos: Todo[];
  history: CompletedTodo[];
}

interface LegacyTodo {
  id: string;
  label: string;
  done: boolean;
}

function defaultData(): StorageData {
  return {
    categories: [],
    todos: [],
    history: [],
  };
}

let storageUri: vscode.Uri | undefined;
let data: StorageData = defaultData();
let onDidChange: (() => void) | undefined;

function fileUri(): vscode.Uri {
  if (!storageUri) {
    throw new Error('StorageService not initialized');
  }
  return vscode.Uri.joinPath(storageUri, FILE_NAME);
}

export async function initStorage(
  context: vscode.ExtensionContext,
  changeCallback: () => void,
): Promise<void> {
  storageUri = context.storageUri;
  onDidChange = changeCallback;

  if (!storageUri) {
    data = defaultData();
    return;
  }

  // Ensure the storage directory exists
  await vscode.workspace.fs.createDirectory(storageUri);

  try {
    const content = await vscode.workspace.fs.readFile(fileUri());
    data = JSON.parse(Buffer.from(content).toString('utf-8')) as StorageData;
  } catch {
    // File doesn't exist yet — try migrating from legacy format
    data = defaultData();
    await migrateLegacy(context);
  }
}

async function migrateLegacy(context: vscode.ExtensionContext): Promise<void> {
  const legacyTodos = context.workspaceState.get<LegacyTodo[]>(LEGACY_STORAGE_KEY);
  if (!legacyTodos || legacyTodos.length === 0) return;

  for (let i = 0; i < legacyTodos.length; i++) {
    const legacy = legacyTodos[i];
    if (legacy.done) {
      data.history.push({
        id: legacy.id,
        title: legacy.label,
        description: undefined,
        categoryId: undefined,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    } else {
      data.todos.push({
        id: legacy.id,
        title: legacy.label,
        description: undefined,
        categoryId: undefined,
        order: i,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await save();
  // Clean up legacy storage
  await context.workspaceState.update(LEGACY_STORAGE_KEY, undefined);
}

async function save(): Promise<void> {
  if (!storageUri) return;
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await vscode.workspace.fs.writeFile(fileUri(), content);
  onDidChange?.();
}

// --- Categories ---

export function getCategories(): Category[] {
  return [...data.categories].sort((a, b) => a.order - b.order);
}

export function getCategoryById(id: string): Category | undefined {
  return data.categories.find((c) => c.id === id);
}

export function getCategoryByName(name: string): Category | undefined {
  return data.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
}

export async function addCategory(category: Category): Promise<void> {
  data.categories.push(category);
  await save();
}

export async function renameCategory(id: string, newName: string): Promise<void> {
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) return;
  cat.name = newName;
  await save();
}

export async function updateCategoryEmoji(id: string, emoji: string | undefined): Promise<void> {
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) return;
  cat.emoji = emoji;
  await save();
}

export async function deleteCategory(id: string): Promise<void> {
  // Move todos to uncategorized (top-level)
  const uncategorized = getUncategorizedTodos();
  let maxOrder = uncategorized.length > 0 ? Math.max(...uncategorized.map((t) => t.order)) + 1 : 0;

  for (const todo of data.todos) {
    if (todo.categoryId === id) {
      todo.categoryId = undefined;
      todo.order = maxOrder++;
    }
  }

  data.categories = data.categories.filter((c) => c.id !== id);
  await save();
}

export async function reorderCategories(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const cat = data.categories.find((c) => c.id === orderedIds[i]);
    if (cat) cat.order = i;
  }
  await save();
}

// --- Todos ---

export function getTodos(): Todo[] {
  return [...data.todos];
}

export function getUncategorizedTodos(): Todo[] {
  return data.todos.filter((t) => t.categoryId === undefined).sort((a, b) => a.order - b.order);
}

export function getTodosByCategory(categoryId: string): Todo[] {
  return data.todos.filter((t) => t.categoryId === categoryId).sort((a, b) => a.order - b.order);
}

export function getTodoById(id: string): Todo | undefined {
  return data.todos.find((t) => t.id === id);
}

export function findTodoByTitle(title: string): Todo | undefined {
  const lower = title.toLowerCase();
  return data.todos.find((t) => t.title.toLowerCase().includes(lower));
}

export async function addTodo(todo: Todo): Promise<void> {
  data.todos.push(todo);
  await save();
}

export async function updateTodo(
  id: string,
  updates: Partial<Pick<Todo, 'title' | 'description' | 'categoryId' | 'order'>>,
): Promise<void> {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) return;
  Object.assign(todo, updates);
  await save();
}

export async function deleteTodo(id: string): Promise<void> {
  data.todos = data.todos.filter((t) => t.id !== id);
  await save();
}

export async function completeTodoById(id: string): Promise<void> {
  const idx = data.todos.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [todo] = data.todos.splice(idx, 1);
  data.history.push({
    id: todo.id,
    title: todo.title,
    description: todo.description,
    categoryId: todo.categoryId,
    createdAt: todo.createdAt,
    completedAt: new Date().toISOString(),
  });
  await save();
}

export async function reorderTodos(
  categoryId: string | undefined,
  orderedIds: string[],
): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    const todo = data.todos.find((t) => t.id === orderedIds[i] && t.categoryId === categoryId);
    if (todo) todo.order = i;
  }
  await save();
}

export async function moveTodoToCategory(
  todoId: string,
  targetCategoryId: string | undefined,
  order: number,
): Promise<void> {
  const todo = data.todos.find((t) => t.id === todoId);
  if (!todo) return;
  todo.categoryId = targetCategoryId;
  todo.order = order;
  await save();
}

// --- History ---

export function getHistory(): CompletedTodo[] {
  return [...data.history].sort(
    (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
  );
}

export async function restoreFromHistory(id: string): Promise<void> {
  const idx = data.history.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [completed] = data.history.splice(idx, 1);

  // Restore to original category, or uncategorized if it no longer exists
  const categoryExists =
    completed.categoryId !== undefined &&
    data.categories.some((c) => c.id === completed.categoryId);
  const categoryId = categoryExists ? completed.categoryId : undefined;
  const order = getNextOrder(categoryId);

  data.todos.push({
    id: completed.id,
    title: completed.title,
    description: completed.description,
    categoryId,
    order,
    createdAt: completed.createdAt,
  });
  await save();
}

export async function purgeHistory(): Promise<void> {
  data.history = [];
  await save();
}

export function getNextOrder(categoryId: string | undefined): number {
  const todos = categoryId === undefined ? getUncategorizedTodos() : getTodosByCategory(categoryId);
  return todos.length > 0 ? Math.max(...todos.map((t) => t.order)) + 1 : 0;
}
