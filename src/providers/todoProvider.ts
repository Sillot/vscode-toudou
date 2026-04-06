import * as vscode from 'vscode';
import { Category } from '../models/category';
import { NO_PRIORITY_ORDER, PRIORITY_ORDER, Todo, TodoPriority } from '../models/todo';
import type { SortMode } from '../services/storageService';

import {
  getCategories,
  getCategoryById,
  getNextOrder,
  getSortMode,
  getTodos,
  getTodosByCategory,
  getUncategorizedTodos,
  moveTodoToCategory,
  reorderCategories,
  reorderTodos,
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

const PRIORITY_ICONS: Record<TodoPriority, string> = {
  high: '⬆ High',
  medium: '— Medium',
  low: '⬇ Low',
};

function priorityCompare(a: Todo, b: Todo): number {
  const pa = a.priority ? PRIORITY_ORDER[a.priority] : NO_PRIORITY_ORDER;
  const pb = b.priority ? PRIORITY_ORDER[b.priority] : NO_PRIORITY_ORDER;
  if (pa !== pb) return pa - pb;
  return a.order - b.order;
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

  private filterText: string | undefined;

  setFilter(text: string | undefined): void {
    this.filterText = text;
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
    if (!this.filterText) return true;
    const text = this.filterText.toLowerCase();
    if (todo.title.toLowerCase().includes(text)) return true;
    if (todo.description !== undefined && todo.description.toLowerCase().includes(text))
      return true;
    if (todo.categoryId) {
      const cat = getCategoryById(todo.categoryId);
      if (cat && cat.name.toLowerCase().includes(text)) return true;
    }
    return false;
  }

  private categoryMatchesFilter(category: Category): boolean {
    if (!this.filterText) return true;
    return category.name.toLowerCase().includes(this.filterText.toLowerCase());
  }

  private getRootChildren(sortMode: SortMode): TreeNode[] {
    if (sortMode === 'priority') {
      // Flat list of all todos sorted by priority
      return [...getTodos()].filter((t) => this.matchesFilter(t)).sort(priorityCompare);
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
    // Drop on empty area → make uncategorized
    if (!target) {
      const order = getNextOrder(undefined);
      await moveTodoToCategory(source.id, undefined, order);
      return;
    }

    if (isCategory(target)) {
      // Drop onto a category → move to end of that category
      const order = getNextOrder(target.id);
      await moveTodoToCategory(source.id, target.id, order);
      return;
    }

    // Drop onto another todo → insert before it
    const targetTodo = target as Todo;
    const targetCategoryId = targetTodo.categoryId;

    if (source.categoryId === targetCategoryId) {
      // Same group: reorder
      const todos =
        targetCategoryId === undefined
          ? getUncategorizedTodos().filter((t) => t.id !== source.id)
          : getTodosByCategory(targetCategoryId).filter((t) => t.id !== source.id);
      const targetIdx = todos.findIndex((t) => t.id === targetTodo.id);
      todos.splice(targetIdx, 0, source);
      await reorderTodos(
        targetCategoryId,
        todos.map((t) => t.id),
      );
    } else {
      // Different group: move then reorder
      const targetTodos =
        targetCategoryId === undefined
          ? getUncategorizedTodos()
          : getTodosByCategory(targetCategoryId);
      const targetIdx = targetTodos.findIndex((t) => t.id === targetTodo.id);
      await moveTodoToCategory(source.id, targetCategoryId, targetIdx);
      const updatedTodos =
        targetCategoryId === undefined
          ? getUncategorizedTodos()
          : getTodosByCategory(targetCategoryId);
      await reorderTodos(
        targetCategoryId,
        updatedTodos.map((t) => t.id),
      );
    }
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

    if (todo.inProgress) {
      item.iconPath = new vscode.ThemeIcon('debug-start', new vscode.ThemeColor('charts.green'));
    }

    const cat = todo.categoryId ? getCategoryById(todo.categoryId) : undefined;
    const parts: string[] = [escapeMarkdown(todo.title)];
    if (todo.priority) {
      parts.push(vscode.l10n.t('Priority: {0}', PRIORITY_ICONS[todo.priority]));
    }
    if (cat) {
      const catLabel = cat.emoji ? `${cat.emoji} ${cat.name}` : cat.name;
      parts.push(vscode.l10n.t('Category: {0}', catLabel));
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

    const sortMode = getSortMode();
    if (sortMode === 'priority') {
      // Show category name as description
      if (cat) {
        item.description = cat.emoji ? `${cat.emoji} ${cat.name}` : cat.name;
      }
    } else {
      // Show priority as description
      if (todo.priority) {
        item.description = PRIORITY_ICONS[todo.priority];
      }
    }

    return item;
  }
}
