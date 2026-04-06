import * as vscode from 'vscode';
import { Category } from '../models/category';
import { CompletedTodo, Todo, TodoPriority } from '../models/todo';

export type SortMode = 'manual' | 'priority' | 'category' | 'categoryPriority';

const LEGACY_STORAGE_KEY = 'toudou.todos';

interface StorageData {
  workspace?: string;
  categories: Category[];
  todos: Todo[];
  history: CompletedTodo[];
  sortMode?: SortMode;
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

const VALID_SORT_MODES: readonly string[] = ['manual', 'priority', 'category', 'categoryPriority'];

function isValidCategory(item: unknown): item is Category {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.order === 'number';
}

function isValidTodo(item: unknown): item is Todo {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string' && typeof o.order === 'number';
}

function isValidCompletedTodo(item: unknown): item is CompletedTodo {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return (
    typeof o.id === 'string' && typeof o.title === 'string' && typeof o.completedAt === 'string'
  );
}

function parseStorageData(raw: string): StorageData {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid storage data');
  }
  const obj = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    obj[key] = value;
  }
  return {
    workspace: typeof obj.workspace === 'string' ? obj.workspace : undefined,
    categories: Array.isArray(obj.categories)
      ? (obj.categories as unknown[]).filter(isValidCategory)
      : [],
    todos: Array.isArray(obj.todos) ? (obj.todos as unknown[]).filter(isValidTodo) : [],
    history: Array.isArray(obj.history)
      ? (obj.history as unknown[]).filter(isValidCompletedTodo)
      : [],
    sortMode:
      typeof obj.sortMode === 'string' && VALID_SORT_MODES.includes(obj.sortMode)
        ? (obj.sortMode as SortMode)
        : undefined,
  };
}

let storageUri: vscode.Uri | undefined;
let resolvedFileUri: vscode.Uri | undefined;
let data: StorageData = defaultData();
let onDidChange: (() => void) | undefined;

const MAX_UNDO_STACK = 50;
const undoStack: string[] = [];
const redoStack: string[] = [];

function fileUri(): vscode.Uri {
  if (!resolvedFileUri) {
    throw new Error('StorageService not initialized');
  }
  return resolvedFileUri;
}

export function getStorageFileUri(): vscode.Uri | undefined {
  return resolvedFileUri;
}

function getWorkspaceName(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return 'default';
  return folders[0].name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

function resolveCustomPath(customPath: string, warnOnAbsolute = false): vscode.Uri | undefined {
  const resolved = customPath.trim().replace(/\{workspace\}/g, getWorkspaceName());

  if (isAbsolutePath(resolved)) {
    if (warnOnAbsolute) {
      vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Toudou: storagePath points to an absolute path "{0}". Make sure you trust this location.',
          resolved,
        ),
      );
    }
    return vscode.Uri.file(resolved);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return undefined;

  const base = workspaceFolders[0].uri;
  const target = vscode.Uri.joinPath(base, resolved);
  const basePath = base.path.endsWith('/') ? base.path : base.path + '/';
  if (!target.path.startsWith(basePath)) {
    vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Toudou: storagePath "{0}" resolves outside the workspace. Ignoring.',
        resolved,
      ),
    );
    return undefined;
  }
  return target;
}

let extensionContext: vscode.ExtensionContext | undefined;

function resolveFileUri(context: vscode.ExtensionContext): vscode.Uri | undefined {
  const workspaceOverride = context.workspaceState.get<string>('storagePath');
  const config = vscode.workspace.getConfiguration('toudou');
  const customPath = workspaceOverride || config.get<string>('defaultStoragePath');

  if (customPath) {
    const isWorkspaceSetting = !!workspaceOverride;
    return resolveCustomPath(customPath, isWorkspaceSetting);
  }

  if (context.storageUri) {
    return vscode.Uri.joinPath(context.storageUri, `toudou-${getWorkspaceName()}.json`);
  }
  return undefined;
}

export async function initStorage(
  context: vscode.ExtensionContext,
  changeCallback: () => void,
): Promise<void> {
  resolvedFileUri = resolveFileUri(context);
  storageUri = resolvedFileUri ? vscode.Uri.joinPath(resolvedFileUri, '..') : undefined;
  extensionContext = context;
  onDidChange = changeCallback;

  if (!resolvedFileUri) {
    data = defaultData();
    return;
  }

  // Ensure the storage directory exists
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(resolvedFileUri, '..'));

  try {
    const content = await vscode.workspace.fs.readFile(fileUri());
    data = parseStorageData(Buffer.from(content).toString('utf-8'));
  } catch {
    // File doesn't exist yet — try migrating from legacy format
    data = defaultData();
    await migrateLegacy(context);
  }

  await deduplicateCategories();
  await backfillWorkspaceName();
}

async function backfillWorkspaceName(): Promise<void> {
  const name = getRawWorkspaceName();
  if (name && data.workspace !== name) {
    data.workspace = name;
    await save();
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
        priority: undefined,
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    } else {
      data.todos.push({
        id: legacy.id,
        title: legacy.label,
        description: undefined,
        categoryId: undefined,
        priority: undefined,
        inProgress: undefined,
        order: i,
        createdAt: new Date().toISOString(),
      });
    }
  }

  await save();
  // Clean up legacy storage
  await context.workspaceState.update(LEGACY_STORAGE_KEY, undefined);
}

async function deduplicateCategories(): Promise<void> {
  const seen = new Map<string, Category>();
  const duplicateIds = new Map<string, string>(); // duplicate id -> kept id

  for (const cat of data.categories) {
    const normalized = cat.name.trim().toLowerCase();
    const existing = seen.get(normalized);
    if (existing) {
      duplicateIds.set(cat.id, existing.id);
    } else {
      seen.set(normalized, cat);
    }
  }

  if (duplicateIds.size === 0) return;

  // Reassign todos from duplicate categories to kept ones
  for (const todo of data.todos) {
    if (todo.categoryId && duplicateIds.has(todo.categoryId)) {
      todo.categoryId = duplicateIds.get(todo.categoryId);
    }
  }
  for (const item of data.history) {
    if (item.categoryId && duplicateIds.has(item.categoryId)) {
      item.categoryId = duplicateIds.get(item.categoryId);
    }
  }

  // Remove duplicate categories
  data.categories = data.categories.filter((c) => !duplicateIds.has(c.id));
  await save();
}

function getRawWorkspaceName(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].name;
}

async function save(): Promise<void> {
  if (!storageUri) return;
  data.workspace = getRawWorkspaceName();
  const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
  await vscode.workspace.fs.writeFile(fileUri(), content);
  onDidChange?.();
}

let batchDepth = 0;

function pushUndo(): void {
  if (batchDepth > 0) return;
  undoStack.push(JSON.stringify(data));
  if (undoStack.length > MAX_UNDO_STACK) {
    undoStack.shift();
  }
  redoStack.length = 0;
}

export function beginUndoBatch(): void {
  if (batchDepth === 0) {
    pushUndo();
  }
  batchDepth++;
}

export function endUndoBatch(): void {
  if (batchDepth > 0) batchDepth--;
}

export async function undo(): Promise<boolean> {
  const snapshot = undoStack.pop();
  if (!snapshot) return false;
  redoStack.push(JSON.stringify(data));
  data = parseStorageData(snapshot);
  await save();
  return true;
}

export async function redo(): Promise<boolean> {
  const snapshot = redoStack.pop();
  if (!snapshot) return false;
  undoStack.push(JSON.stringify(data));
  data = parseStorageData(snapshot);
  await save();
  return true;
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
  pushUndo();
  data.categories.push(category);
  await save();
}

export async function renameCategory(id: string, newName: string): Promise<void> {
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) return;
  pushUndo();
  cat.name = newName;
  await save();
}

export async function updateCategoryEmoji(id: string, emoji: string | undefined): Promise<void> {
  const cat = data.categories.find((c) => c.id === id);
  if (!cat) return;
  pushUndo();
  cat.emoji = emoji;
  await save();
}

export async function deleteCategory(id: string): Promise<void> {
  pushUndo();
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
  pushUndo();
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
  // Prefer exact match, then fall back to partial match only if unambiguous
  const exact = data.todos.find((t) => t.title.toLowerCase() === lower);
  if (exact) return exact;
  const matches = data.todos.filter((t) => t.title.toLowerCase().includes(lower));
  return matches.length === 1 ? matches[0] : undefined;
}

export async function addTodo(todo: Todo): Promise<void> {
  pushUndo();
  data.todos.push(todo);
  await save();
}

const ALLOWED_TODO_UPDATE_KEYS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'categoryId',
  'order',
  'priority',
]);

export async function updateTodo(
  id: string,
  updates: Partial<Pick<Todo, 'title' | 'description' | 'categoryId' | 'order' | 'priority'>>,
): Promise<void> {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) return;
  pushUndo();
  for (const key of Object.keys(updates)) {
    if (ALLOWED_TODO_UPDATE_KEYS.has(key)) {
      (todo as unknown as Record<string, unknown>)[key] = (
        updates as unknown as Record<string, unknown>
      )[key];
    }
  }
  await save();
}

export async function deleteTodo(id: string): Promise<void> {
  pushUndo();
  data.todos = data.todos.filter((t) => t.id !== id);
  await save();
}

export async function completeTodoById(id: string): Promise<void> {
  const idx = data.todos.findIndex((t) => t.id === id);
  if (idx === -1) return;
  pushUndo();
  const [todo] = data.todos.splice(idx, 1);
  data.history.push({
    id: todo.id,
    title: todo.title,
    description: todo.description,
    categoryId: todo.categoryId,
    priority: todo.priority,
    createdAt: todo.createdAt,
    completedAt: new Date().toISOString(),
  });
  await save();
}

export async function reorderTodos(
  categoryId: string | undefined,
  orderedIds: string[],
): Promise<void> {
  pushUndo();
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
  pushUndo();
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
  pushUndo();
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
    priority: completed.priority,
    inProgress: undefined,
    order,
    createdAt: completed.createdAt,
  });
  await save();
}

export async function purgeHistory(): Promise<void> {
  pushUndo();
  data.history = [];
  await save();
}

export function getNextOrder(categoryId: string | undefined): number {
  const todos = categoryId === undefined ? getUncategorizedTodos() : getTodosByCategory(categoryId);
  return todos.length > 0 ? Math.max(...todos.map((t) => t.order)) + 1 : 0;
}

// --- Sort Mode ---

export function getSortMode(): SortMode {
  return data.sortMode ?? 'manual';
}

export async function setSortMode(mode: SortMode): Promise<void> {
  pushUndo();
  data.sortMode = mode;
  await save();
}

// --- Priority ---

export async function setTodoPriority(
  id: string,
  priority: TodoPriority | undefined,
): Promise<void> {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) return;
  pushUndo();
  todo.priority = priority;
  await save();
}

// --- In Progress ---

export async function setTodoInProgress(id: string, inProgress: boolean): Promise<void> {
  const todo = data.todos.find((t) => t.id === id);
  if (!todo) return;
  pushUndo();
  todo.inProgress = inProgress || undefined;
  await save();
}

// --- Workspace Storage Path ---

export function getWorkspaceStoragePath(): string | undefined {
  return extensionContext?.workspaceState.get<string>('storagePath');
}

export async function setWorkspaceStoragePath(path: string | undefined): Promise<void> {
  if (!extensionContext) return;
  const trimmed = path?.trim() || undefined;
  await extensionContext.workspaceState.update('storagePath', trimmed);
  await initStorage(extensionContext, onDidChange ?? (() => {}));
  onDidChange?.();
}

// --- Export / Import ---

export interface ExportCategory {
  name: string;
  emoji?: string;
}

export interface ExportTodo {
  title: string;
  description?: string;
  category?: string;
  priority?: TodoPriority;
}

export interface ExportData {
  categories: ExportCategory[];
  todos: ExportTodo[];
}

export function buildExportData(todoIds?: string[]): ExportData {
  const todosToExport = todoIds?.length
    ? data.todos.filter((t) => todoIds.includes(t.id))
    : [...data.todos];

  const usedCategoryIds = new Set(
    todosToExport.map((t) => t.categoryId).filter((id): id is string => id !== undefined),
  );

  const categories: ExportCategory[] = data.categories
    .filter((c) => usedCategoryIds.has(c.id))
    .sort((a, b) => a.order - b.order)
    .map((c) => {
      const entry: ExportCategory = { name: c.name };
      if (c.emoji) entry.emoji = c.emoji;
      return entry;
    });

  const todos: ExportTodo[] = todosToExport.map((t) => {
    const cat = t.categoryId ? data.categories.find((c) => c.id === t.categoryId) : undefined;
    const entry: ExportTodo = { title: t.title };
    if (t.description) entry.description = t.description;
    if (cat) entry.category = cat.name;
    if (t.priority) entry.priority = t.priority;
    return entry;
  });

  return { categories, todos };
}

const VALID_PRIORITIES: ReadonlySet<string> = new Set(['high', 'medium', 'low']);

const IMPORT_MAX_TITLE = 500;
const IMPORT_MAX_DESCRIPTION = 2000;
const IMPORT_MAX_CATEGORY = 100;
const IMPORT_MAX_TODOS = 10_000;
const IMPORT_MAX_CATEGORIES = 500;

export function parseExportData(raw: unknown): ExportData | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const obj = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    obj[key] = value;
  }

  const categories: ExportCategory[] = [];
  if (Array.isArray(obj.categories)) {
    for (const item of obj.categories as unknown[]) {
      if (categories.length >= IMPORT_MAX_CATEGORIES) break;
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > IMPORT_MAX_CATEGORY)
        continue;
      const cat: ExportCategory = { name: o.name.trim() };
      if (typeof o.emoji === 'string' && o.emoji.trim()) cat.emoji = o.emoji.trim();
      categories.push(cat);
    }
  }

  const todos: ExportTodo[] = [];
  if (Array.isArray(obj.todos)) {
    for (const item of obj.todos as unknown[]) {
      if (todos.length >= IMPORT_MAX_TODOS) break;
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.title !== 'string' || !o.title.trim() || o.title.length > IMPORT_MAX_TITLE)
        continue;
      const todo: ExportTodo = { title: o.title.trim() };
      if (
        typeof o.description === 'string' &&
        o.description.trim() &&
        o.description.length <= IMPORT_MAX_DESCRIPTION
      ) {
        todo.description = o.description.trim();
      }
      if (
        typeof o.category === 'string' &&
        o.category.trim() &&
        o.category.length <= IMPORT_MAX_CATEGORY
      ) {
        todo.category = o.category.trim();
      }
      if (typeof o.priority === 'string' && VALID_PRIORITIES.has(o.priority)) {
        todo.priority = o.priority as TodoPriority;
      }
      todos.push(todo);
    }
  }

  if (todos.length === 0 && categories.length === 0) return undefined;

  return { categories, todos };
}

export async function importData(exportData: ExportData): Promise<number> {
  pushUndo();

  const categoryMap = new Map<string, string>();
  for (const cat of data.categories) {
    categoryMap.set(cat.name.toLowerCase(), cat.id);
  }

  // Index export categories for emoji metadata
  const exportCategoryMeta = new Map<string, ExportCategory>();
  for (const ec of exportData.categories) {
    exportCategoryMeta.set(ec.name.toLowerCase(), ec);
  }

  // Create declared categories that don't exist yet
  for (const exportCat of exportData.categories) {
    const normalized = exportCat.name.toLowerCase();
    if (!categoryMap.has(normalized)) {
      const maxOrder =
        data.categories.length > 0 ? Math.max(...data.categories.map((c) => c.order)) + 1 : 0;
      const newCat: Category = {
        id: crypto.randomUUID(),
        name: exportCat.name,
        order: maxOrder,
        emoji: exportCat.emoji,
      };
      data.categories.push(newCat);
      categoryMap.set(normalized, newCat.id);
    }
  }

  // Import todos, auto-creating categories referenced by name
  let count = 0;
  for (const exportTodo of exportData.todos) {
    let categoryId: string | undefined;
    if (exportTodo.category) {
      const normalized = exportTodo.category.toLowerCase();
      if (!categoryMap.has(normalized)) {
        const meta = exportCategoryMeta.get(normalized);
        const maxOrder =
          data.categories.length > 0 ? Math.max(...data.categories.map((c) => c.order)) + 1 : 0;
        const newCat: Category = {
          id: crypto.randomUUID(),
          name: exportTodo.category,
          order: maxOrder,
          emoji: meta?.emoji,
        };
        data.categories.push(newCat);
        categoryMap.set(normalized, newCat.id);
      }
      categoryId = categoryMap.get(normalized);
    }

    const order = getNextOrder(categoryId);
    data.todos.push({
      id: crypto.randomUUID(),
      title: exportTodo.title,
      description: exportTodo.description,
      categoryId,
      priority: exportTodo.priority,
      inProgress: undefined,
      order,
      createdAt: new Date().toISOString(),
    });
    count++;
  }

  await save();
  return count;
}
