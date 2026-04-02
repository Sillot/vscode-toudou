import * as vscode from 'vscode';
import { CompletedTodo } from '../models/todo';
import { getHistory, getCategoryById } from '../services/storageService';

export class HistoryProvider implements vscode.TreeDataProvider<CompletedTodo> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CompletedTodo | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: CompletedTodo): vscode.TreeItem {
    const completedDate = new Date(element.completedAt).toLocaleDateString();
    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    item.description = `completed ${completedDate}`;
    item.contextValue = 'completedTodo';
    item.iconPath = new vscode.ThemeIcon('pass-filled');

    const category = element.categoryId ? getCategoryById(element.categoryId) : undefined;
    const tooltipParts = [element.title];
    if (element.description) tooltipParts.push(element.description);
    if (category) tooltipParts.push(`Category: ${category.name}`);
    tooltipParts.push(`Completed: ${completedDate}`);
    item.tooltip = tooltipParts.join('\n');

    return item;
  }

  getChildren(): CompletedTodo[] {
    return getHistory();
  }
}
