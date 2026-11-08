export type TodoPriority = 'high' | 'medium' | 'low';

export const PRIORITY_ORDER: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export const NO_PRIORITY_ORDER = 3;

export interface Todo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  priority: TodoPriority | undefined;
  inProgress: boolean | undefined;
  order: number;
  createdAt: string;
  /** See {@link readTags}: the file may hold another tool's value here. */
  tags?: unknown;
  /** See {@link readDueDate}. */
  dueDate?: unknown;
}

export interface CompletedTodo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  priority: TodoPriority | undefined;
  createdAt: string;
  completedAt: string;
  /** Carried through completion and restore. See {@link readTags}. */
  tags?: unknown;
  /** Carried through completion and restore. See {@link readDueDate}. */
  dueDate?: unknown;
}

/**
 * Tags as the file stores them: trimmed, without a leading `#`, empty ones
 * dropped, one per name whatever its case, the first spelling winning. A tag is
 * its name and nothing else (same rule as Toudou Desktop's `normalizeTags`).
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of raw) {
    const name = tag.trim().replace(/^#+/, '').trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      tags.push(name);
    }
  }
  return tags;
}

/**
 * The tags of a todo or history entry. Typed `unknown` on the entry because the
 * file is shared: a `tags` that is not an array belongs to some other tool, is
 * displayed as none and is never rewritten.
 */
export function readTags(item: { tags?: unknown }): string[] {
  if (!Array.isArray(item.tags)) return [];
  return normalizeTags(item.tags.filter((t): t is string => typeof t === 'string'));
}

/** Whether `tags` holds `name`, ignoring case: Toudou Desktop's `hasTag`. */
export function hasTag(tags: readonly string[], name: string): boolean {
  const needle = name.toLowerCase();
  return tags.some((t) => t.toLowerCase() === needle);
}

/** True when `tags` holds a value Toudou must leave alone. */
export function hasForeignTags(item: { tags?: unknown }): boolean {
  return item.tags !== undefined && !Array.isArray(item.tags);
}

/** `#call #work`, for the views. */
export function formatTags(tags: readonly string[]): string {
  return tags.map((t) => `#${t}`).join(' ');
}

const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a real calendar day written `YYYY-MM-DD`: a plain date, not a
 * timestamp, so "the 5th" is the same day in every time zone (Toudou Desktop's
 * format). Rejects impossible days such as 2026-02-30.
 */
export function isValidDueDate(value: string): boolean {
  if (!DUE_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * The due date of a todo or history entry. Like `tags`, a value that is not a
 * string belongs to some other tool: shown as none, never rewritten. A string is
 * used as it is, which is what Toudou Desktop does.
 */
export function readDueDate(item: { dueDate?: unknown }): string | undefined {
  return typeof item.dueDate === 'string' && item.dueDate ? item.dueDate : undefined;
}

/** True when `dueDate` holds a value Toudou must leave alone. */
export function hasForeignDueDate(item: { dueDate?: unknown }): boolean {
  return item.dueDate !== undefined && typeof item.dueDate !== 'string';
}

/** Today's local calendar day, `YYYY-MM-DD`. */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Due strictly before `today`. Zero-padded ISO dates compare exactly as strings. */
export function isOverdue(item: { dueDate?: unknown }, today: string): boolean {
  const due = readDueDate(item);
  return due !== undefined && due < today;
}

/**
 * Soonest deadline first, undated todos last, ties in manual order: Toudou
 * Desktop's `byDueDate`.
 */
export function compareByDueDate(a: Todo, b: Todo): number {
  const da = readDueDate(a);
  const db = readDueDate(b);
  if (da === db) return a.order - b.order;
  if (da === undefined) return 1;
  if (db === undefined) return -1;
  return da < db ? -1 : 1;
}

export function createTodo(
  title: string,
  categoryId?: string,
  description?: string,
  order: number = 0,
  priority?: TodoPriority,
  tags: readonly string[] = [],
  dueDate?: string,
): Todo {
  const normalized = normalizeTags(tags);
  return {
    id: crypto.randomUUID(),
    title,
    description,
    categoryId,
    priority,
    inProgress: undefined,
    order,
    createdAt: new Date().toISOString(),
    // Written only when there are some, like Toudou Desktop.
    tags: normalized.length > 0 ? normalized : undefined,
    dueDate,
  };
}

export function duplicateTodo(source: Todo, categoryId: string | undefined, order: number): Todo {
  const tags = readTags(source);
  return {
    id: crypto.randomUUID(),
    title: source.title,
    description: source.description,
    categoryId,
    priority: source.priority,
    inProgress: undefined,
    order,
    createdAt: new Date().toISOString(),
    tags: tags.length > 0 ? tags : undefined,
    dueDate: readDueDate(source),
  };
}
