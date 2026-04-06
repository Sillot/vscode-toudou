import * as vscode from 'vscode';
import { CompletedTodo } from '../models/todo';
import { getCategoryById, getHistory } from '../services/storageService';

function escapeMarkdown(text: string): string {
  return text.replace(/[\[\]()#*_~`>|\\!]/g, '\\$&');
}

interface FilterIndicator {
  readonly kind: 'filter';
  readonly text: string;
}

type HistoryNode = CompletedTodo | FilterIndicator;

function isFilterIndicator(node: HistoryNode): node is FilterIndicator {
  return 'kind' in node && (node as FilterIndicator).kind === 'filter';
}

export class HistoryProvider implements vscode.TreeDataProvider<HistoryNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

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

  getTreeItem(element: HistoryNode): vscode.TreeItem {
    if (isFilterIndicator(element)) {
      const item = new vscode.TreeItem(
        vscode.l10n.t('Filter: {0}', element.text),
        vscode.TreeItemCollapsibleState.None,
      );
      item.contextValue = 'filterIndicator';
      item.iconPath = new vscode.ThemeIcon('search');
      item.command = {
        command: 'toudou.filterHistory',
        title: '',
      };
      return item;
    }

    const completedDate = new Date(element.completedAt).toLocaleDateString();
    const item = new vscode.TreeItem(element.title, vscode.TreeItemCollapsibleState.None);
    item.description = vscode.l10n.t('completed {0}', completedDate);
    item.contextValue = 'completedTodo';
    item.checkboxState = vscode.TreeItemCheckboxState.Checked;

    const category = element.categoryId ? getCategoryById(element.categoryId) : undefined;
    const parts: string[] = [escapeMarkdown(element.title)];
    if (category) parts.push(vscode.l10n.t('Category: {0}', category.name));
    parts.push(vscode.l10n.t('Completed: {0}', completedDate));
    if (element.description) {
      parts.push('---', escapeMarkdown(element.description));
    }
    const tooltip = new vscode.MarkdownString(parts.join('\n\n'));
    tooltip.isTrusted = { enabledCommands: [] };
    item.tooltip = tooltip;

    return item;
  }

  getChildren(): HistoryNode[] {
    const history = getHistory();
    const filtered = this.filterText
      ? history.filter((t) => {
          const text = this.filterText!.toLowerCase();
          return (
            t.title.toLowerCase().includes(text) ||
            (t.description !== undefined && t.description.toLowerCase().includes(text))
          );
        })
      : history;
    if (this.filterText) {
      return [{ kind: 'filter', text: this.filterText }, ...filtered];
    }
    return filtered;
  }
}
