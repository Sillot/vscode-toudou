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

/** True when `tags` holds a value Toudou must leave alone. */
export function hasForeignTags(item: { tags?: unknown }): boolean {
  return item.tags !== undefined && !Array.isArray(item.tags);
}

/** `#call #work`, for the views. */
export function formatTags(tags: readonly string[]): string {
  return tags.map((t) => `#${t}`).join(' ');
}

export function createTodo(
  title: string,
  categoryId?: string,
  description?: string,
  order: number = 0,
  priority?: TodoPriority,
  tags: readonly string[] = [],
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
  };
}
