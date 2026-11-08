import * as vscode from 'vscode';
import { Category } from '../models/category';
import { categoryNameMatches, matchesFilter, parseFilter, TodoFilter } from '../models/filter';
import {
  compareByDueDate,
  formatTags,
  isOverdue,
  NO_PRIORITY_ORDER,
  PRIORITY_ORDER,
  readDueDate,
  readTags,
  todayLocal,
  Todo,
  TodoPriority,
} from '../models/todo';
import type { SortMode } from '../services/storageService';

import {
  getCategories,
  getCategoryById,
  getSortMode,
  getTodos,
  getTodosByCategory,
  getUncategorizedTodos,
  moveTodoBefore,
  reorderCategories,
} from '../services/storageService';

const DRAG_MIME = 'application/vnd.code.tree.toudouView';

function escapeMarkdown(text: string): string {
  return text.replace(/[\[\]()#*_~`>|\\!]/g, '\\$&');
}

export interface FilterIndicator {
  readonly kind: 'filter';
  readonly text: string;
}

type TreeNode = Category | Todo | FilterIndicator;

function isFilterIndicator(node: TreeNode): node is FilterIndicator {
  return 'kind' in node && (node as FilterIndicator).kind === 'filter';
}

const PRIORITY_GLYPHS: Record<TodoPriority, string> = {
  high: '⬆',
  medium: '—',
  low: '⬇',
};

/**
 * Resolved on each call rather than in a module-level table: `l10n.t` needs the
 * bundle, which is not loaded yet when this module is first evaluated. The glyph
 * stays out of the translated string, so a translator only handles the word.
 */
function priorityLabel(priority: TodoPriority): string {
  const name =
    priority === 'high'
      ? vscode.l10n.t('High')
      : priority === 'medium'
        ? vscode.l10n.t('Medium')
        : vscode.l10n.t('Low');
  return `${PRIORITY_GLYPHS[priority]} ${name}`;
}

function priorityCompare(a: Todo, b: Todo): number {
  const pa = a.priority ? PRIORITY_ORDER[a.priority] : NO_PRIORITY_ORDER;
  const pb = b.priority ? PRIORITY_ORDER[b.priority] : NO_PRIORITY_ORDER;
  if (pa !== pb) return pa - pb;
  return a.order - b.order;
}

/** Modes listing every todo in one flat list, without category groups. */
function isFlatSort(sortMode: SortMode): boolean {
  return sortMode === 'priority' || sortMode === 'dueDate';
}

function isCategory(node: TreeNode): node is Category {
  return 'name' in node && !('title' in node);
}

function isTodo(node: TreeNode): node is Todo {
  return 'title' in node;
}

export class TodoProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  /** Raw, for the indicator row; {@link filter} is what matching reads. */
  private filterText: string | undefined;
  private filter: TodoFilter | undefined;

  setFilter(text: string | undefined): void {
    this.filterText = text;
    this.filter = text ? parseFilter(text) : undefined;
    // Shows the clear button in the view title only while a filter is set.
    void vscode.commands.executeCommand('setContext', 'toudou.todoFilterActive', !!text);
    this.refresh();
  }

  getFilter(): string | undefined {
    return this.filterText;
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isFilterIndicator(element)) {
      return this.getFilterItem(element);
    }
    if (isCategory(element)) {
      return this.getCategoryItem(element);
    }
    return this.getTodoItem(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      if (isFilterIndicator(element)) return [];
      if (isCategory(element)) {
        return this.getCategoryChildren(element.id, getSortMode());
      }
      return [];
    }
    const children: TreeNode[] = [];
    if (this.filterText) {
      children.push({ kind: 'filter', text: this.filterText });
    }
    children.push(...this.getRootChildren(getSortMode()));
    return children;
  }

  private matchesFilter(todo: Todo): boolean {
    if (!this.filter) return true;
    const cat = todo.categoryId ? getCategoryById(todo.categoryId) : undefined;
    return matchesFilter(todo, [todo.title, todo.description, cat?.name], this.filter);
  }

  private categoryMatchesFilter(category: Category): boolean {
    if (!this.filter) return true;
    return categoryNameMatches(category.name, this.filter);
  }

  private getRootChildren(sortMode: SortMode): TreeNode[] {
    if (isFlatSort(sortMode)) {
      return [...getTodos()]
        .filter((t) => this.matchesFilter(t))
        .sort(sortMode === 'dueDate' ? compareByDueDate : priorityCompare);
    }
    // manual, category, categoryPriority: uncategorized todos first, then categories
    const uncategorized = getUncategorizedTodos().filter((t) => this.matchesFilter(t));
    const categories = this.filterText
      ? getCategories().filter(
          (c) =>
            this.categoryMatchesFilter(c) ||
            getTodosByCategory(c.id).some((t) => this.matchesFilter(t)),
        )
      : getCategories();
    if (sortMode === 'categoryPriority') {
      return ([...uncategorized].sort(priorityCompare) as TreeNode[]).concat(categories);
    }
    return [...uncategorized, ...categories];
  }

  private getCategoryChildren(categoryId: string, sortMode: SortMode): Todo[] {
    const category = getCategoryById(categoryId);
    const showAll = category && this.categoryMatchesFilter(category);
    const todos = showAll
      ? getTodosByCategory(categoryId)
      : getTodosByCategory(categoryId).filter((t) => this.matchesFilter(t));
    if (sortMode === 'categoryPriority') {
      return [...todos].sort(priorityCompare);
    }
    return todos;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (isFilterIndicator(element)) return undefined;
    if (isTodo(element) && element.categoryId !== undefined) {
      return getCategories().find((c) => c.id === element.categoryId);
    }
    return undefined;
  }

  // --- Drag & Drop ---

  handleDrag(
    source: readonly TreeNode[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(source));
  }

  async handleDrop(
    target: TreeNode | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const transferItem = dataTransfer.get(DRAG_MIME);
    if (!transferItem) return;

    const sources = transferItem.value as TreeNode[];
    if (sources.length === 0) return;

    const source = sources[0];

    // Ignore filter indicator
    if (isFilterIndicator(source)) return;
    if (target && isFilterIndicator(target)) return;

    try {
      // Category dropped on root or another category → reorder categories
      if (isCategory(source)) {
        if (target && isTodo(target)) return; // Can't drop category onto a todo
        await this.handleCategoryDrop(source, target as Category | undefined);
        return;
      }

      // Todo dropped → reorder, move between categories, or move to/from uncategorized
      if (isTodo(source)) {
        await this.handleTodoDrop(source, target);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to move item: {0}', message));
    }
  }

  private async handleCategoryDrop(source: Category, target: Category | undefined): Promise<void> {
    const categories = getCategories();
    const filtered = categories.filter((c) => c.id !== source.id);

    if (!target) {
      filtered.push(source);
    } else {
      const targetIdx = filtered.findIndex((c) => c.id === target.id);
      filtered.splice(targetIdx, 0, source);
    }

    await reorderCategories(filtered.map((c) => c.id));
  }

  private async handleTodoDrop(source: Todo, target: TreeNode | undefined): Promise<void> {
    // Drop on empty area → move to the end of the uncategorized group
    if (!target) {
      await moveTodoBefore(source.id, undefined, undefined);
      return;
    }

    // Drop onto a category → move to the end of that category
    if (isCategory(target)) {
      await moveTodoBefore(source.id, target.id, undefined);
      return;
    }

    // Drop onto another todo → insert before it. A single call so the move and
    // the renumbering share one read-modify-write and one undo step, and so the
    // positions are computed from the file rather than from this stale tree.
    const targetTodo = target as Todo;
    await moveTodoBefore(source.id, targetTodo.categoryId, targetTodo.id);
  }

  private getFilterItem(filter: FilterIndicator): vscode.TreeItem {
    const item = new vscode.TreeItem(
      vscode.l10n.t('Filter: {0}', filter.text),
      vscode.TreeItemCollapsibleState.None,
    );
    item.contextValue = 'filterIndicator';
    item.iconPath = new vscode.ThemeIcon('search');
    item.command = {
      command: 'toudou.filterTodos',
      title: '',
    };
    return item;
  }

  private getCategoryItem(category: Category): vscode.TreeItem {
    const todos = getTodosByCategory(category.id);
    const label = category.emoji
      ? `${category.emoji} ${category.name} (${todos.length})`
      : `${category.name} (${todos.length})`;
    const item = new vscode.TreeItem(
      label,
      todos.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.contextValue = 'category';
    if (!category.emoji) {
      item.iconPath = new vscode.ThemeIcon('folder');
    }
    return item;
  }

  private getTodoItem(todo: Todo): vscode.TreeItem {
    const item = new vscode.TreeItem(todo.title, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'todo';
    item.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
    item.command = {
      command: 'toudou.clickTodo',
      title: '',
      arguments: [todo],
    };

    const due = readDueDate(todo);
    const overdue = isOverdue(todo, todayLocal());
    // A state is shown as a coloured icon; in progress wins, overdue still
    // reads in the description.
    if (todo.inProgress) {
      item.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('charts.green'));
    } else if (overdue) {
      item.iconPath = new vscode.ThemeIcon(
        'calendar',
        new vscode.ThemeColor('list.errorForeground'),
      );
    }

    const cat = todo.categoryId ? getCategoryById(todo.categoryId) : undefined;
    const parts: string[] = [escapeMarkdown(todo.title)];
    if (todo.priority) {
      parts.push(vscode.l10n.t('Priority: {0}', priorityLabel(todo.priority)));
    }
    const catLabel = cat ? (cat.emoji ? `${cat.emoji} ${cat.name}` : cat.name) : undefined;
    if (catLabel) {
      parts.push(vscode.l10n.t('Category: {0}', catLabel));
    }
    if (due) {
      parts.push(
        overdue
          ? vscode.l10n.t('Due: {0} (overdue)', escapeMarkdown(due))
          : vscode.l10n.t('Due: {0}', escapeMarkdown(due)),
      );
    }
    const tagText = formatTags(readTags(todo));
    if (tagText) {
      parts.push(vscode.l10n.t('Tags: {0}', escapeMarkdown(tagText)));
    }
    if (todo.description) {
      parts.push('---', escapeMarkdown(todo.description));
    }
    const copyArgs = encodeURIComponent(JSON.stringify(todo.id));
    parts.push(`[$(copy) ${vscode.l10n.t('Copy')}](command:toudou.copyTodoText?${copyArgs})`);
    const tooltip = new vscode.MarkdownString(parts.join('\n\n'));
    tooltip.supportThemeIcons = true;
    tooltip.isTrusted = { enabledCommands: ['toudou.copyTodoText'] };
    item.tooltip = tooltip;

    // The category in a flat sort (the tree no longer groups by it), the
    // priority otherwise; then the due date and the tags.
    const detail = isFlatSort(getSortMode())
      ? catLabel
      : todo.priority
        ? priorityLabel(todo.priority)
        : undefined;
    const dueText = due
      ? overdue
        ? vscode.l10n.t('due {0} (overdue)', due)
        : vscode.l10n.t('due {0}', due)
      : undefined;
    item.description = [detail, dueText, tagText].filter(Boolean).join('  ') || undefined;

    return item;
  }
}
