import * as vscode from 'vscode';
import { CompletedTodo } from '../models/todo';
import { getCategoryById, getHistory } from '../services/storageService';

export class HistoryProvider implements vscode.TreeDataProvider<CompletedTodo> {
  private _onDidChangeTreeData = new vscode.EventEmitter<CompletedTodo | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: CompletedTodo): vscode.TreeItem {
    const completedDate = new Date(element.completedAt).toLocaleDateString();
    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    item.description = vscode.l10n.t('completed {0}', completedDate);
    item.contextValue = 'completedTodo';
    item.checkboxState = vscode.TreeItemCheckboxState.Checked;

    const category = element.categoryId ? getCategoryById(element.categoryId) : undefined;
    const tooltipParts = [element.title];
    if (element.description) tooltipParts.push(element.description);
    if (category) tooltipParts.push(vscode.l10n.t('Category: {0}', category.name));
    tooltipParts.push(vscode.l10n.t('Completed: {0}', completedDate));
    item.tooltip = tooltipParts.join('\n');

    return item;
  }

  getChildren(): CompletedTodo[] {
    return getHistory();
  }
}
