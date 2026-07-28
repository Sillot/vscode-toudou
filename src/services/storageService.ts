import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { Category } from '../models/category';
import { CompletedTodo, Todo, TodoPriority } from '../models/todo';
import {
  applyManualOrder,
  defaultData,
  describeFsError,
  errnoOf,
  expandHome,
  isAbsolutePath,
  isInside,
  isMissing,
  parseStorageData,
  RENAME_LOCK_CODES,
  sameSignature,
  serializeStorageData,
  SortMode,
  StorageData,
  StorageSignature,
  trimUndoStack,
} from './storageCore';

export type { SortMode };

const LEGACY_STORAGE_KEY = 'toudou.todos';

interface LegacyTodo {
  id: string;
  label: string;
  done: boolean;
}

let resolvedFileUri: vscode.Uri | undefined;
let data: StorageData = defaultData();
let onDidChange: (() => void) | undefined;
/** `undefined` when the file does not exist, or when our last write could not be attributed. */
let knownSignature: StorageSignature | undefined;
let reportedError: string | undefined;
/**
 * Set while the file exists but could not be read or parsed.
 *
 * Writing in that state would replace real data with whatever little we hold —
 * a truncated file caught mid-sync would cost the user everything — so every
 * mutation is refused until a read succeeds again.
 */
let loadFailed = false;
/** Keeps a multi-selection command from raising one dialog per item. */
let blockedNotified = false;

const MAX_UNDO_STACK = 50;
/** Total characters of JSON kept in the undo stack; a shared file can be large. */
const MAX_UNDO_CHARS = 4_000_000;
const undoStack: string[] = [];
const redoStack: string[] = [];

export function getStorageFileUri(): vscode.Uri | undefined {
  return resolvedFileUri;
}

// --- Serialized disk access ---

let pendingOperation: Promise<unknown> = Promise.resolve();

/**
 * Runs disk operations one at a time. Without it a watcher poll could reload
 * `data` in the middle of a mutation's read-modify-write and drop the change.
 */
function queue<T>(task: () => Promise<T>): Promise<T> {
  const run = pendingOperation.then(task, task);
  pendingOperation = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// --- Error reporting ---

/** A locked or malformed file is hit again on every poll: only surface it once. */
function reportError(message: string): void {
  if (reportedError === message) return;
  reportedError = message;
  vscode.window.showErrorMessage(message);
}

function reportReadError(error: unknown): void {
  reportError(
    vscode.l10n.t('Toudou: could not read the storage file. {0}', describeFsError(error)),
  );
}

function clearError(): void {
  reportedError = undefined;
}

/**
 * Guards every write. Reported outside {@link reportError}'s deduplication: the
 * user just asked for a change and has to learn it did not happen, even if the
 * underlying read error was already dismissed.
 */
function writesBlocked(): boolean {
  if (!loadFailed) return false;
  if (!blockedNotified) {
    blockedNotified = true;
    vscode.window.showErrorMessage(
      vscode.l10n.t(
        'Toudou: change not saved, the storage file could not be read. Fix or move "{0}", then run "Toudou: Reload Storage File".',
        resolvedFileUri?.fsPath ?? '',
      ),
    );
  }
  return true;
}

/** Called from the two places a successful read is established. */
function clearLoadFailure(): void {
  loadFailed = false;
  blockedNotified = false;
}

// --- Filesystem helpers ---

interface ReadResult {
  /** `undefined` when the file does not exist yet. */
  content: string | undefined;
  signature: StorageSignature | undefined;
}

async function readStorageFile(uri: vscode.Uri): Promise<ReadResult> {
  try {
    // Stat before read, never in parallel: a signature older than the content
    // only costs one redundant reload, whereas a signature newer than the
    // content makes us believe we are current and hides the change for good.
    const stat = await vscode.workspace.fs.stat(uri);
    const raw = await vscode.workspace.fs.readFile(uri);
    return {
      content: Buffer.from(raw).toString('utf-8'),
      signature: { mtime: stat.mtime, size: stat.size },
    };
  } catch (error) {
    if (isMissing(error)) return { content: undefined, signature: undefined };
    throw error;
  }
}

async function readSignature(uri: vscode.Uri): Promise<StorageSignature | undefined> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return { mtime: stat.mtime, size: stat.size };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function temporaryUriFor(uri: vscode.Uri): vscode.Uri {
  const slash = uri.path.lastIndexOf('/');
  const folder = uri.path.slice(0, slash + 1);
  const name = uri.path.slice(slash + 1);
  // Dot-prefixed so the leftovers of a crashed window stay out of the way in a
  // synced or version-controlled folder. The pid keeps two windows apart.
  return uri.with({ path: `${folder}.${name}.${process.pid}.tmp` });
}

/** Old enough that no window can still be renaming it into place. */
const TEMP_MAX_AGE_MS = 60_000;

/** Sweeps the temporary files left behind by a window that died mid-write. */
async function cleanStaleTemporaries(uri: vscode.Uri): Promise<void> {
  const folder = vscode.Uri.joinPath(uri, '..');
  const slash = uri.path.lastIndexOf('/');
  const prefix = `.${uri.path.slice(slash + 1)}.`;

  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(folder);
  } catch {
    return;
  }

  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) continue;
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = vscode.Uri.joinPath(folder, name);
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if (Date.now() - stat.mtime < TEMP_MAX_AGE_MS) continue;
      await vscode.workspace.fs.delete(candidate, { useTrash: false });
    } catch {
      // Already gone, or held by someone else: not worth reporting.
    }
  }
}

/**
 * Writes through a temporary file and renames it into place, so a reader (the
 * Obsidian plugin, a sync client) never observes a half-written file.
 *
 * When the rename is blocked — typically a sync client holding the target open
 * on Windows — falls back to writing the destination directly. That trades the
 * atomicity guarantee for actually saving the user's data, which is the right
 * call: losing the change is worse than a reader catching a partial file during
 * the few milliseconds of a rewrite.
 */
async function writeStorageFile(
  uri: vscode.Uri,
  content: Uint8Array,
): Promise<StorageSignature | undefined> {
  const temporary = temporaryUriFor(uri);
  try {
    await vscode.workspace.fs.writeFile(temporary, content);
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } catch (error) {
    await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).then(
      () => undefined,
      () => undefined,
    );
    if (!RENAME_LOCK_CODES.has(errnoOf(error) ?? '')) throw error;
    await vscode.workspace.fs.writeFile(uri, content);
  }

  const signature = await readSignature(uri);
  // A size that does not match what we just wrote means someone replaced the
  // file between the rename and the stat. Leaving the signature unset makes the
  // next poll reload their revision instead of adopting it as ours.
  if (signature && signature.size !== content.byteLength) return undefined;
  return signature;
}

// --- Path resolution ---

function getWorkspaceName(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return 'default';
  return folders[0].name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

const ACKNOWLEDGED_PATHS_KEY = 'acknowledgedAbsolutePaths';
const MAX_ACKNOWLEDGED_PATHS = 20;

function rememberAcknowledgedPath(context: vscode.ExtensionContext, resolved: string): void {
  const acknowledged = context.globalState.get<string[]>(ACKNOWLEDGED_PATHS_KEY) ?? [];
  if (acknowledged.includes(resolved)) return;
  void context.globalState.update(
    ACKNOWLEDGED_PATHS_KEY,
    [...acknowledged, resolved].slice(-MAX_ACKNOWLEDGED_PATHS),
  );
}

/**
 * An absolute path escapes the workspace by design — that is how the file gets
 * shared with Obsidian or a synced folder — so it cannot be refused, only
 * surfaced. Shown once per distinct path so a deliberate setup stays quiet.
 */
function warnAboutAbsolutePath(context: vscode.ExtensionContext, resolved: string): void {
  const acknowledged = context.globalState.get<string[]>(ACKNOWLEDGED_PATHS_KEY) ?? [];
  if (acknowledged.includes(resolved)) return;
  rememberAcknowledgedPath(context, resolved);
  vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Toudou: storagePath points to an absolute path "{0}". Make sure you trust this location.',
      resolved,
    ),
  );
}

/**
 * Marks a path as already vetted. Call it for a location the user picked in a
 * dialog: warning them about a folder they just chose themselves is noise.
 */
export function acknowledgeStoragePath(path: string): void {
  if (!extensionContext) return;
  rememberAcknowledgedPath(extensionContext, path.trim());
}

function resolveCustomPath(
  context: vscode.ExtensionContext,
  customPath: string,
): vscode.Uri | undefined {
  const resolved = expandHome(
    customPath.trim().replace(/\{workspace\}/g, getWorkspaceName()),
    homedir(),
  );

  if (isAbsolutePath(resolved)) {
    warnAboutAbsolutePath(context, resolved);
    return vscode.Uri.file(resolved);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders) return undefined;

  const base = workspaceFolders[0].uri;
  const target = vscode.Uri.joinPath(base, resolved);
  if (!isInside(base.path, target.path)) {
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
    return resolveCustomPath(context, customPath);
  }

  if (context.storageUri) {
    return vscode.Uri.joinPath(context.storageUri, `toudou-${getWorkspaceName()}.json`);
  }
  return undefined;
}

// --- Lifecycle ---

export async function initStorage(
  context: vscode.ExtensionContext,
  changeCallback: () => void,
): Promise<void> {
  await queue(async () => {
    resolvedFileUri = resolveFileUri(context);
    extensionContext = context;
    onDidChange = changeCallback;
    knownSignature = undefined;
    data = defaultData();
    clearLoadFailure();
    clearUndoHistory();
    clearError();

    if (!resolvedFileUri) return;

    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(resolvedFileUri, '..'));
    } catch (error) {
      // Nothing below can work without the folder, and the caller only chains a
      // `then`: reporting here is the user's single chance to learn about it.
      loadFailed = true;
      reportError(
        vscode.l10n.t('Toudou: could not create the storage folder. {0}', describeFsError(error)),
      );
      return;
    }

    let result: ReadResult;
    try {
      result = await readStorageFile(resolvedFileUri);
    } catch (error) {
      // Unreadable, not absent. Saving now would replace real data with an empty
      // list, so leave the file alone and let the user fix it.
      loadFailed = true;
      reportReadError(error);
      return;
    }

    if (result.content === undefined) {
      // No file yet — bring over anything left by the pre-1.0 workspaceState format.
      await migrateLegacy(context);
    } else {
      try {
        data = parseStorageData(result.content);
      } catch (error) {
        loadFailed = true;
        reportError(
          vscode.l10n.t('Toudou: the storage file is not valid JSON. {0}', describeFsError(error)),
        );
        return;
      }
      knownSignature = result.signature;
    }

    await cleanStaleTemporaries(resolvedFileUri);
    await deduplicateCategories();
    await backfillWorkspaceName();
  });
}

/**
 * Re-reads the file unconditionally. Returns true when the in-memory state
 * actually changed.
 *
 * A read or parse failure keeps the current state on purpose: blanking it would
 * let the next mutation overwrite the file with an empty list. `loadFailed`
 * makes that guarantee hold beyond this call by refusing writes outright.
 */
async function reload(): Promise<boolean> {
  if (!resolvedFileUri) return false;

  let result: ReadResult;
  try {
    result = await readStorageFile(resolvedFileUri);
  } catch (error) {
    loadFailed = true;
    reportReadError(error);
    return false;
  }

  if (result.content === undefined) {
    // The file vanished — an unmounted drive, a sync client resolving a conflict
    // by renaming it away, a user moving it. Keeping what we have means the next
    // write restores it; blanking it would persist the disappearance instead.
    knownSignature = undefined;
    return false;
  }

  let next: StorageData;
  try {
    next = parseStorageData(result.content);
  } catch (error) {
    loadFailed = true;
    reportError(
      vscode.l10n.t('Toudou: the storage file is not valid JSON. {0}', describeFsError(error)),
    );
    return false;
  }

  const before = serializeStorageData(data);
  data = next;
  knownSignature = result.signature;
  clearLoadFailure();
  clearError();
  return serializeStorageData(data) !== before;
}

/**
 * Reloads when the file moved underneath us. Returns true only when the contents
 * actually differ: an mtime bump on its own — our own write, a sync client
 * rewriting an identical file — is not an external edit and must stay silent.
 */
async function refreshIfChangedOnDisk(): Promise<boolean> {
  if (!resolvedFileUri) return false;

  let signature: StorageSignature | undefined;
  try {
    signature = await readSignature(resolvedFileUri);
  } catch (error) {
    reportReadError(error);
    return false;
  }
  if (sameSignature(signature, knownSignature)) return false;

  const changed = await reload();
  // The snapshots describe a state the file no longer has.
  if (changed) clearUndoHistory();
  return changed;
}

/** Polled by the storage watcher. Returns true when the views must be refreshed. */
export function checkForExternalChanges(): Promise<boolean> {
  return queue(() => refreshIfChangedOnDisk());
}

/** Forced re-read, behind the `toudou.reloadStorage` command. */
export function reloadStorage(): Promise<boolean> {
  return queue(async () => {
    const changed = await reload();
    if (changed) clearUndoHistory();
    return changed;
  });
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
  if (!resolvedFileUri || loadFailed) return;
  const name = getRawWorkspaceName();
  if (name) data.workspace = name;

  const content = Buffer.from(serializeStorageData(data), 'utf-8');
  try {
    knownSignature = await writeStorageFile(resolvedFileUri, content);
    clearError();
    onDidChange?.();
  } catch (error) {
    // The change never reached the disk. Showing it anyway would leave the views
    // lying until the next restart — the file's signature is unchanged, so the
    // poll loop has nothing to correct with. Re-read instead, so what is on
    // screen is always what is on disk.
    clearUndoHistory();
    await reload();
    onDidChange?.();
    reportError(
      vscode.l10n.t('Toudou: could not save the storage file. {0}', describeFsError(error)),
    );
  }
}

/**
 * The single entry point for every write.
 *
 * Re-reads the file first so a change made elsewhere — the Obsidian plugin,
 * another window, another machine through a synced folder — is never clobbered:
 * the mutation is applied on top of the freshest state instead of a stale
 * in-memory copy. `apply` must therefore look up the entities it touches itself;
 * a reference captured before the call belongs to the previous state object, and
 * so does any index or order computed from it.
 *
 * Returning `false` from `apply` aborts the write (nothing found to change).
 */
async function mutate(apply: () => boolean | void): Promise<void> {
  await queue(async () => {
    const external = await refreshIfChangedOnDisk();
    // Whoever bails out early still owes the views a refresh: the re-read above
    // already consumed the external change and updated the signature, so the
    // poll loop will not report it a second time.
    if (writesBlocked()) {
      if (external) onDidChange?.();
      return;
    }
    const snapshot = serializeStorageData(data);
    if (apply() === false) {
      if (external) onDidChange?.();
      return;
    }
    commitUndo(snapshot);
    await save();
  });
}

// --- Undo / redo ---

let batchDepth = 0;
let pendingBatchSnapshot: string | undefined;

function clearUndoHistory(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  pendingBatchSnapshot = undefined;
}

function commitUndo(snapshot: string): void {
  if (batchDepth > 0) {
    // Keep only the state from before the whole batch.
    pendingBatchSnapshot ??= snapshot;
    return;
  }
  pushUndoSnapshot(snapshot);
}

function pushUndoSnapshot(snapshot: string): void {
  undoStack.push(snapshot);
  trimUndoStack(undoStack, MAX_UNDO_STACK, MAX_UNDO_CHARS);
  redoStack.length = 0;
}

export function beginUndoBatch(): void {
  batchDepth++;
}

export function endUndoBatch(): void {
  if (batchDepth === 0) return;
  batchDepth--;
  if (batchDepth === 0 && pendingBatchSnapshot !== undefined) {
    pushUndoSnapshot(pendingBatchSnapshot);
    pendingBatchSnapshot = undefined;
  }
}

export function undo(): Promise<boolean> {
  return queue(async () => {
    // May clear the stacks: a snapshot taken before an external edit would
    // silently revert that edit too.
    const external = await refreshIfChangedOnDisk();
    const snapshot = writesBlocked() ? undefined : undoStack.pop();
    if (snapshot === undefined) {
      if (external) onDidChange?.();
      return false;
    }
    redoStack.push(serializeStorageData(data));
    data = parseStorageData(snapshot);
    await save();
    return true;
  });
}

export function redo(): Promise<boolean> {
  return queue(async () => {
    const external = await refreshIfChangedOnDisk();
    const snapshot = writesBlocked() ? undefined : redoStack.pop();
    if (snapshot === undefined) {
      if (external) onDidChange?.();
      return false;
    }
    undoStack.push(serializeStorageData(data));
    data = parseStorageData(snapshot);
    await save();
    return true;
  });
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

export function getNextCategoryOrder(): number {
  return Math.max(...data.categories.map((c) => c.order), -1) + 1;
}

export async function addCategory(category: Category): Promise<void> {
  // The order is recomputed here: the one the caller measured predates the
  // re-read and may already be taken by a category added elsewhere.
  await mutate(() => {
    data.categories.push({ ...category, order: getNextCategoryOrder() });
  });
}

export async function renameCategory(id: string, newName: string): Promise<void> {
  await mutate(() => {
    const cat = data.categories.find((c) => c.id === id);
    if (!cat) return false;
    cat.name = newName;
  });
}

export async function updateCategoryEmoji(id: string, emoji: string | undefined): Promise<void> {
  await mutate(() => {
    const cat = data.categories.find((c) => c.id === id);
    if (!cat) return false;
    cat.emoji = emoji;
  });
}

export async function deleteCategory(id: string): Promise<void> {
  await mutate(() => {
    if (!data.categories.some((c) => c.id === id)) return false;
    // Move todos to uncategorized (top-level), after the existing ones.
    let order = getNextOrder(undefined);
    for (const todo of data.todos) {
      if (todo.categoryId === id) {
        todo.categoryId = undefined;
        todo.order = order++;
      }
    }
    data.categories = data.categories.filter((c) => c.id !== id);
  });
}

export async function reorderCategories(orderedIds: string[]): Promise<void> {
  await mutate(() => {
    applyManualOrder(data.categories, orderedIds);
  });
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
  // Same as addCategory: the caller's order predates the re-read.
  await mutate(() => {
    data.todos.push({ ...todo, order: getNextOrder(todo.categoryId) });
  });
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
  await mutate(() => {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo) return false;
    for (const key of Object.keys(updates)) {
      if (ALLOWED_TODO_UPDATE_KEYS.has(key)) {
        (todo as unknown as Record<string, unknown>)[key] = (
          updates as unknown as Record<string, unknown>
        )[key];
      }
    }
  });
}

export async function deleteTodo(id: string): Promise<void> {
  await mutate(() => {
    if (!data.todos.some((t) => t.id === id)) return false;
    data.todos = data.todos.filter((t) => t.id !== id);
  });
}

export async function completeTodoById(id: string): Promise<void> {
  await mutate(() => {
    const idx = data.todos.findIndex((t) => t.id === id);
    if (idx === -1) return false;
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
  });
}

/**
 * Moves a todo into `targetCategoryId`, just before `beforeTodoId` — or to the
 * end when it is undefined — and renumbers the whole target group.
 *
 * Takes ids rather than an index on purpose: the caller measured its indices
 * before {@link mutate} re-read the file, so anything positional it computed is
 * already stale.
 */
export async function moveTodoBefore(
  todoId: string,
  targetCategoryId: string | undefined,
  beforeTodoId: string | undefined,
): Promise<void> {
  await mutate(() => {
    // Dropping a todo onto itself asks for nothing.
    if (beforeTodoId === todoId) return false;
    const todo = data.todos.find((t) => t.id === todoId);
    if (!todo) return false;

    todo.categoryId = targetCategoryId;
    const group = data.todos
      .filter((t) => t.categoryId === targetCategoryId)
      .sort((a, b) => a.order - b.order);

    const orderedIds = group.filter((t) => t.id !== todoId).map((t) => t.id);
    const insertAt = beforeTodoId ? orderedIds.indexOf(beforeTodoId) : -1;
    orderedIds.splice(insertAt === -1 ? orderedIds.length : insertAt, 0, todoId);

    applyManualOrder(group, orderedIds);
  });
}

// --- History ---

export function getHistory(): CompletedTodo[] {
  return [...data.history].sort(
    (a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime(),
  );
}

export async function restoreFromHistory(id: string): Promise<void> {
  await mutate(() => {
    const idx = data.history.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const [completed] = data.history.splice(idx, 1);

    // Restore to original category, or uncategorized if it no longer exists
    const categoryExists =
      completed.categoryId !== undefined &&
      data.categories.some((c) => c.id === completed.categoryId);
    const categoryId = categoryExists ? completed.categoryId : undefined;

    data.todos.push({
      id: completed.id,
      title: completed.title,
      description: completed.description,
      categoryId,
      priority: completed.priority,
      inProgress: undefined,
      order: getNextOrder(categoryId),
      createdAt: completed.createdAt,
    });
  });
}

export async function purgeHistory(): Promise<void> {
  await mutate(() => {
    if (data.history.length === 0) return false;
    data.history = [];
  });
}

export function getNextOrder(categoryId: string | undefined): number {
  let max = -1;
  for (const todo of data.todos) {
    if (todo.categoryId === categoryId && todo.order > max) max = todo.order;
  }
  return max + 1;
}

// --- Sort Mode ---

export function getSortMode(): SortMode {
  return data.sortMode ?? 'manual';
}

export async function setSortMode(mode: SortMode): Promise<void> {
  await mutate(() => {
    if (data.sortMode === mode) return false;
    data.sortMode = mode;
  });
}

// --- Priority ---

export async function setTodoPriority(
  id: string,
  priority: TodoPriority | undefined,
): Promise<void> {
  await mutate(() => {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo) return false;
    todo.priority = priority;
  });
}

// --- In Progress ---

export async function setTodoInProgress(id: string, inProgress: boolean): Promise<void> {
  await mutate(() => {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo) return false;
    todo.inProgress = inProgress || undefined;
  });
}

/** Flips the flag from whatever the file says now, not from the caller's copy. */
export async function toggleTodoInProgress(id: string): Promise<void> {
  await mutate(() => {
    const todo = data.todos.find((t) => t.id === id);
    if (!todo) return false;
    todo.inProgress = todo.inProgress ? undefined : true;
  });
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
  let count = 0;

  await mutate(() => {
    // Built inside the callback: the category list may have grown on disk since
    // the file dialog was opened.
    const categoryMap = new Map<string, string>();
    for (const cat of data.categories) {
      categoryMap.set(cat.name.toLowerCase(), cat.id);
    }

    // Index export categories for emoji metadata
    const exportCategoryMeta = new Map<string, ExportCategory>();
    for (const ec of exportData.categories) {
      exportCategoryMeta.set(ec.name.toLowerCase(), ec);
    }

    const ensureCategory = (name: string, emoji: string | undefined): string => {
      const normalized = name.toLowerCase();
      const existing = categoryMap.get(normalized);
      if (existing) return existing;
      const created: Category = {
        id: crypto.randomUUID(),
        name,
        order: getNextCategoryOrder(),
        emoji,
      };
      data.categories.push(created);
      categoryMap.set(normalized, created.id);
      return created.id;
    };

    // Orders are handed out from a running counter: rescanning every todo for
    // each of the 10 000 an import may carry would freeze the extension host.
    const nextOrder = new Map<string | undefined, number>();
    const takeOrder = (categoryId: string | undefined): number => {
      const order = nextOrder.get(categoryId) ?? getNextOrder(categoryId);
      nextOrder.set(categoryId, order + 1);
      return order;
    };

    // Create declared categories that don't exist yet
    for (const exportCat of exportData.categories) {
      ensureCategory(exportCat.name, exportCat.emoji);
    }

    // Import todos, auto-creating categories referenced by name
    for (const exportTodo of exportData.todos) {
      const categoryId = exportTodo.category
        ? ensureCategory(
            exportTodo.category,
            exportCategoryMeta.get(exportTodo.category.toLowerCase())?.emoji,
          )
        : undefined;

      data.todos.push({
        id: crypto.randomUUID(),
        title: exportTodo.title,
        description: exportTodo.description,
        categoryId,
        priority: exportTodo.priority,
        inProgress: undefined,
        order: takeOrder(categoryId),
        createdAt: new Date().toISOString(),
      });
      count++;
    }
  });

  return count;
}
