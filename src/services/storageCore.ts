import { Category } from '../models/category';
import { CompletedTodo, Todo } from '../models/todo';

/**
 * Pure helpers shared by the storage service and its watcher.
 *
 * Deliberately free of the `vscode` API so the parts that are easy to get
 * wrong — round-tripping a file another editor also writes, comparing file
 * revisions, normalizing manual order — can be unit-tested outside VS Code.
 */

export type SortMode = 'manual' | 'priority' | 'category' | 'categoryPriority';

const VALID_SORT_MODES: readonly string[] = ['manual', 'priority', 'category', 'categoryPriority'];

/**
 * Everything in the file this version does not understand.
 *
 * The storage file is shared with other clients (the Obsidian plugin, a newer
 * Toudou). Since every write rewrites the whole document, anything not kept
 * here would be destroyed the first time the user ticks a checkbox.
 */
export interface ForeignData {
  /** Top-level keys we do not own. */
  keys: Record<string, unknown>;
  /** Entries that failed validation, kept verbatim and re-emitted as-is. */
  categories: unknown[];
  todos: unknown[];
  history: unknown[];
}

export interface StorageData {
  workspace?: string;
  categories: Category[];
  todos: Todo[];
  history: CompletedTodo[];
  sortMode?: SortMode;
  foreign: ForeignData;
}

export function emptyForeignData(): ForeignData {
  return {
    keys: Object.create(null) as Record<string, unknown>,
    categories: [],
    todos: [],
    history: [],
  };
}

export function defaultData(): StorageData {
  return {
    categories: [],
    todos: [],
    history: [],
    foreign: emptyForeignData(),
  };
}

// --- Validation ---

export function isValidCategory(item: unknown): item is Category {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.name === 'string' && typeof o.order === 'number';
}

export function isValidTodo(item: unknown): item is Todo {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return typeof o.id === 'string' && typeof o.title === 'string' && typeof o.order === 'number';
}

export function isValidCompletedTodo(item: unknown): item is CompletedTodo {
  if (typeof item !== 'object' || item === null) return false;
  const o = item as Record<string, unknown>;
  return (
    typeof o.id === 'string' && typeof o.title === 'string' && typeof o.completedAt === 'string'
  );
}

// --- Parsing / serialization ---

const OWNED_KEYS: ReadonlySet<string> = new Set([
  'workspace',
  'categories',
  'todos',
  'history',
  'sortMode',
]);

/** Never round-tripped: re-emitting them would hand a prototype to the parser. */
const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function split<T>(value: unknown, isValid: (item: unknown) => item is T, rejected: unknown[]): T[] {
  if (!Array.isArray(value)) return [];
  const accepted: T[] = [];
  for (const item of value as unknown[]) {
    if (isValid(item)) accepted.push(item);
    else rejected.push(item);
  }
  return accepted;
}

export function parseStorageData(raw: string): StorageData {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid storage data');
  }

  const owned = Object.create(null) as Record<string, unknown>;
  const foreign = emptyForeignData();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (OWNED_KEYS.has(key)) owned[key] = value;
    else foreign.keys[key] = value;
  }

  return {
    workspace: typeof owned.workspace === 'string' ? owned.workspace : undefined,
    categories: split(owned.categories, isValidCategory, foreign.categories),
    todos: split(owned.todos, isValidTodo, foreign.todos),
    history: split(owned.history, isValidCompletedTodo, foreign.history),
    sortMode:
      typeof owned.sortMode === 'string' && VALID_SORT_MODES.includes(owned.sortMode)
        ? (owned.sortMode as SortMode)
        : undefined,
    foreign,
  };
}

/** Inverse of {@link parseStorageData}: what we understood, plus what we did not. */
export function serializeStorageData(data: StorageData): string {
  const out: Record<string, unknown> = {};
  if (data.workspace !== undefined) out.workspace = data.workspace;
  out.categories = [...data.categories, ...data.foreign.categories];
  out.todos = [...data.todos, ...data.foreign.todos];
  out.history = [...data.history, ...data.foreign.history];
  if (data.sortMode !== undefined) out.sortMode = data.sortMode;
  for (const [key, value] of Object.entries(data.foreign.keys)) out[key] = value;
  return JSON.stringify(out, null, 2);
}

// --- File revisions ---

/** Identifies the revision of the file we last read or wrote. */
export interface StorageSignature {
  mtime: number;
  size: number;
}

export function sameSignature(
  a: StorageSignature | undefined,
  b: StorageSignature | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  // Size is compared too: filesystems with a coarse mtime granularity can time
  // two consecutive writes to the same tick.
  return a.mtime === b.mtime && a.size === b.size;
}

// --- Filesystem errors ---

/** Node puts the errno at the head of the message, and VS Code keeps that message. */
const ERRNO_PATTERN = /(?:^|[\s:(])(E[A-Z]{2,}):/;

export function errnoOf(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const match = ERRNO_PATTERN.exec(message);
  if (match) return match[1];
  // Fall back to the VS Code error code (FileNotFound, NoPermissions…).
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function isMissing(error: unknown): boolean {
  const code = errnoOf(error);
  return code === 'ENOENT' || code === 'FileNotFound';
}

/**
 * Prefixes the message with the errno (EPERM, EACCES, EBUSY…): without it a disk
 * problem is indistinguishable from a bug in the extension.
 */
export function describeFsError(error: unknown): string {
  const code = errnoOf(error);
  const message = error instanceof Error ? error.message : String(error);
  if (!code || message.includes(code)) return message;
  return `${code}: ${message}`;
}

/**
 * Errnos meaning "the rename could not replace the target right now" rather than
 * "you may not write here". Cloud-sync clients (Synology Drive, OneDrive,
 * Dropbox) routinely hold a transient lock on the file they are uploading, and
 * on Windows that surfaces as one of these.
 */
export const RENAME_LOCK_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'EEXIST',
  'ENOTEMPTY',
  'NoPermissions',
  'FileExists',
  'Unavailable',
]);

// --- Paths ---

/**
 * Expands a leading `~` to the home directory.
 *
 * Without it `~/.toudou/todos.json` reads as a relative path and lands in a
 * directory literally named `~` at the root of the workspace — which is exactly
 * what the documented example would have produced.
 */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (!p.startsWith('~/') && !p.startsWith('~\\')) return p;
  const trimmed = home.replace(/[\\/]$/, '');
  return trimmed + p.slice(1);
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);
}

/** True when `target` sits under `base`. Both must already be normalized. */
export function isInside(base: string, target: string): boolean {
  const prefix = base.endsWith('/') ? base : base + '/';
  return target.startsWith(prefix);
}

// --- Manual order ---

const UNRANKED = Number.MAX_SAFE_INTEGER;

/**
 * Rewrites `order` over `items` so it matches `orderedIds`, gaplessly.
 *
 * Items missing from `orderedIds` — created by another editor while the drag was
 * in flight — keep their relative position at the end rather than colliding with
 * a stale index, so no two entries ever share an order.
 */
export function applyManualOrder<T extends { id: string; order: number }>(
  items: T[],
  orderedIds: readonly string[],
): void {
  const rank = new Map<string, number>();
  orderedIds.forEach((id, index) => rank.set(id, index));
  // Sorted by the current order first, so the stable sort below preserves the
  // existing relative order of everything the caller did not mention.
  const sorted = [...items].sort((a, b) => a.order - b.order);
  sorted.sort((a, b) => (rank.get(a.id) ?? UNRANKED) - (rank.get(b.id) ?? UNRANKED));
  sorted.forEach((item, index) => {
    item.order = index;
  });
}

// --- Undo stack ---

/**
 * Drops the oldest snapshots until the stack fits both budgets. A shared file
 * can be large, and a full JSON snapshot per step adds up fast; the most recent
 * snapshot is always kept so undo never becomes a no-op.
 */
export function trimUndoStack(stack: string[], maxEntries: number, maxChars: number): void {
  let total = 0;
  for (const snapshot of stack) total += snapshot.length;
  while (stack.length > 1 && (stack.length > maxEntries || total > maxChars)) {
    total -= stack.shift()!.length;
  }
  if (stack.length > maxEntries) stack.splice(0, stack.length - maxEntries);
}

// --- Watcher settings ---

export const DEFAULT_INTERVAL_SECONDS = 3;
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 3600;

/**
 * Settings read from `settings.json` are not coerced, so a hand-edited string or
 * a negative value would reach `setInterval` as `NaN` — which it treats as 0,
 * turning the poll into a busy loop against a synced folder.
 */
export function clampWatchIntervalSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(Math.max(Math.round(value), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}
