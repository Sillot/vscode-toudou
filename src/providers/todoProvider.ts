import * as vscode from 'vscode';
import { Category } from '../models/category';
import { Todo } from '../models/todo';
import {
  getCategories,
  getNextOrder,
  getTodosByCategory,
  getUncategorizedTodos,
  moveTodoToCategory,
  reorderCategories,
  reorderTodos,
} from '../services/storageService';

const DRAG_MIME = 'application/vnd.code.tree.toudouView';

type TreeNode = Category | Todo;

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

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (isCategory(element)) {
      return this.getCategoryItem(element);
    }
    return this.getTodoItem(element);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Root: uncategorized todos first, then categories
      const uncategorized = getUncategorizedTodos();
      const categories = getCategories();
      return [...uncategorized, ...categories];
    }
    if (isCategory(element)) {
      return getTodosByCategory(element.id);
    }
    return [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
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
    item.tooltip = todo.description ? `${todo.title}\n${todo.description}` : todo.title;
    return item;
  }
}
