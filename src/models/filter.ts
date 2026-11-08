import { hasTag, readTags } from './todo';

/**
 * The filter box of both views, split into what it asks for.
 *
 * Every `#word` is a tag the entry must carry, by its whole name, so `#rdv`
 * does not catch `rdv-medecin`. The other words are plain text, searched as a
 * substring. Mixing both means both: the tags must all be carried AND the text
 * must match, which is how Toudou Desktop reads its search box.
 */
export interface TodoFilter {
  tags: string[];
  /** Lowercased; empty when the filter is tags only. */
  text: string;
}

export function parseFilter(raw: string): TodoFilter {
  const tags: string[] = [];
  const words: string[] = [];
  for (const word of raw.trim().split(/\s+/)) {
    if (!word.startsWith('#')) {
      if (word) words.push(word);
      continue;
    }
    // A lone `#` asks for nothing.
    const name = word.replace(/^#+/, '');
    if (name) tags.push(name);
  }
  return { tags, text: words.join(' ').toLowerCase() };
}

/**
 * Whether an entry passes the filter. `fields` are what plain text searches
 * besides the tag names: title, description, category name.
 */
export function matchesFilter(
  item: { tags?: unknown },
  fields: readonly (string | undefined)[],
  filter: TodoFilter,
): boolean {
  const tags = readTags(item);
  if (!filter.tags.every((tag) => hasTag(tags, tag))) return false;
  if (!filter.text) return true;
  return [...fields, ...tags].some((f) => f?.toLowerCase().includes(filter.text));
}

/**
 * Whether a category's name alone shows it with all its todos. Never when the
 * filter asks for tags: a category is then shown only for its matching todos.
 */
export function categoryNameMatches(name: string, filter: TodoFilter): boolean {
  return filter.tags.length === 0 && filter.text !== '' && name.toLowerCase().includes(filter.text);
}
