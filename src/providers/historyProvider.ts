import * as vscode from 'vscode';
import { matchesFilter, parseFilter, TodoFilter } from '../models/filter';
import { CompletedTodo, formatTags, readDueDate, readTags } from '../models/todo';
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

  /** Raw, for the indicator row; {@link filter} is what matching reads. */
  private filterText: string | undefined;
  private filter: TodoFilter | undefined;

  setFilter(text: string | undefined): void {
    this.filterText = text;
    this.filter = text ? parseFilter(text) : undefined;
    // Shows the clear button in the view title only while a filter is set.
    void vscode.commands.executeCommand('setContext', 'toudou.historyFilterActive', !!text);
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
    // No overdue cue: the todo is done, its deadline no longer runs.
    const due = readDueDate(element);
    const tagText = formatTags(readTags(element));
    item.description = [
      vscode.l10n.t('completed {0}', completedDate),
      due ? vscode.l10n.t('due {0}', due) : undefined,
      tagText,
    ]
      .filter(Boolean)
      .join('  ');
    item.contextValue = 'completedTodo';
    item.checkboxState = vscode.TreeItemCheckboxState.Checked;

    const category = element.categoryId ? getCategoryById(element.categoryId) : undefined;
    const parts: string[] = [escapeMarkdown(element.title)];
    if (category) parts.push(vscode.l10n.t('Category: {0}', category.name));
    parts.push(vscode.l10n.t('Completed: {0}', completedDate));
    if (due) parts.push(vscode.l10n.t('Due: {0}', escapeMarkdown(due)));
    if (tagText) parts.push(vscode.l10n.t('Tags: {0}', escapeMarkdown(tagText)));
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
    const filter = this.filter;
    const filtered = filter
      ? history.filter((t) => matchesFilter(t, [t.title, t.description], filter))
      : history;
    if (this.filterText) {
      return [{ kind: 'filter', text: this.filterText }, ...filtered];
    }
    return filtered;
  }
}
