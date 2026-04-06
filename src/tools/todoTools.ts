import * as vscode from 'vscode';
import { createCategory } from '../models/category';
import { createTodo } from '../models/todo';
import * as storage from '../services/storageService';

const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_CATEGORY_LENGTH = 100;

function textResult(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
}

function validateString(
  value: string | undefined,
  label: string,
  maxLength: number,
  required = true,
): string | undefined {
  if (!value || value.trim().length === 0) {
    if (required) return `${label} is required and cannot be empty.`;
    return undefined;
  }
  if (value.length > maxLength) {
    return `${label} is too long (max ${maxLength} characters).`;
  }
  return undefined;
}

export function registerTodoTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool('getToudouList', new GetToudouListTool()),
    vscode.lm.registerTool('manageToudou', new ManageToudouTool()),
  );
}

// --- getToudouList ---

interface GetToudouListParams {
  category?: string;
}

class GetToudouListTool implements vscode.LanguageModelTool<GetToudouListParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<GetToudouListParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    let todos = storage.getTodos();
    const categories = storage.getCategories();

    if (options.input.category) {
      const cat = storage.getCategoryByName(options.input.category);
      if (!cat) {
        return textResult(`Category "${options.input.category}" not found.`);
      }
      todos = todos.filter((t) => t.categoryId === cat.id);
    }

    const catLines = categories.map((c) => `- ${c.name}`);
    const catSection =
      catLines.length > 0 ? `Categories:\n${catLines.join('\n')}` : 'No categories.';

    if (todos.length === 0) {
      return textResult(`${catSection}\n\nNo todos found.`);
    }

    const todoLines = todos.map((t) => {
      const cat = categories.find((c) => c.id === t.categoryId);
      const parts = [`- [${cat?.name ?? 'Uncategorized'}] ${t.title}`];
      if (t.description) parts.push(`  ${t.description}`);
      if (t.inProgress) parts.push('  [IN PROGRESS]');
      return parts.join('\n');
    });

    return textResult(
      `${catSection}\n\nTodos:\n${todoLines.join('\n')}\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }
}

// --- manageToudou ---

type ManageToudouAction =
  | 'createTodo'
  | 'completeTodo'
  | 'deleteTodo'
  | 'createCategory'
  | 'renameCategory'
  | 'deleteCategory';

interface ManageToudouParams {
  action: ManageToudouAction;
  title?: string;
  id?: string;
  category?: string;
  categoryId?: string;
  categoryName?: string;
  description?: string;
  name?: string;
  newName?: string;
}

class ManageToudouTool implements vscode.LanguageModelTool<ManageToudouParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ManageToudouParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { action } = options.input;

    switch (action) {
      case 'createTodo':
        return this.createTodo(options.input);
      case 'completeTodo':
        return this.completeTodo(options.input);
      case 'deleteTodo':
        return this.deleteTodo(options.input);
      case 'createCategory':
        return this.createCategory(options.input);
      case 'renameCategory':
        return this.renameCategory(options.input);
      case 'deleteCategory':
        return this.deleteCategory(options.input);
      default:
        return textResult(`Unknown action "${action}".`);
    }
  }

  private async createTodo(params: ManageToudouParams): Promise<vscode.LanguageModelToolResult> {
    const { title, description } = params;

    const titleErr = validateString(title, 'Title', MAX_TITLE_LENGTH);
    if (titleErr) return textResult(titleErr);
    const descErr = validateString(description, 'Description', MAX_DESCRIPTION_LENGTH, false);
    if (descErr) return textResult(descErr);

    let categoryId: string | undefined;
    const categoryInput = params.category ?? params.categoryName;

    if (params.categoryId) {
      const byId = storage.getCategoryById(params.categoryId);
      if (!byId) return textResult(`Category with id "${params.categoryId}" not found.`);
      categoryId = byId.id;
    } else if (categoryInput) {
      const catErr = validateString(categoryInput, 'Category', MAX_CATEGORY_LENGTH);
      if (catErr) return textResult(catErr);
      const existing = storage.getCategoryByName(categoryInput);
      if (existing) {
        categoryId = existing.id;
      } else {
        const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
        const newCat = createCategory(categoryInput, maxOrder);
        await storage.addCategory(newCat);
        categoryId = newCat.id;
      }
    }

    const order = storage.getNextOrder(categoryId);
    const todo = createTodo(title!, categoryId, description, order);
    await storage.addTodo(todo);

    const catName = categoryId ? storage.getCategoryById(categoryId)?.name : undefined;
    const locationText = catName ? ` in category "${catName}"` : '';
    return textResult(
      `Created todo "${title}"${locationText}.\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }

  private async completeTodo(params: ManageToudouParams): Promise<vscode.LanguageModelToolResult> {
    const todo = findTodo(params);
    if (!todo) return textResult('Todo not found.');

    await storage.completeTodoById(todo.id);
    return textResult(
      `Completed todo "${todo.title}".\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }

  private async deleteTodo(params: ManageToudouParams): Promise<vscode.LanguageModelToolResult> {
    const todo = findTodo(params);
    if (!todo) return textResult('Todo not found.');

    await storage.deleteTodo(todo.id);
    return textResult(
      `Deleted todo "${todo.title}".\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }

  private async createCategory(
    params: ManageToudouParams,
  ): Promise<vscode.LanguageModelToolResult> {
    const { name } = params;

    const nameErr = validateString(name, 'Name', MAX_CATEGORY_LENGTH);
    if (nameErr) return textResult(nameErr);

    const existing = storage.getCategoryByName(name!);
    if (existing) {
      return textResult(`Category "${name}" already exists.`);
    }

    const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
    const cat = createCategory(name!, maxOrder);
    await storage.addCategory(cat);

    return textResult(
      `Created category "${name}".\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }

  private async renameCategory(
    params: ManageToudouParams,
  ): Promise<vscode.LanguageModelToolResult> {
    const { name, newName } = params;

    const nameErr = validateString(name, 'Name', MAX_CATEGORY_LENGTH);
    if (nameErr) return textResult(nameErr);
    const newNameErr = validateString(newName, 'New name', MAX_CATEGORY_LENGTH);
    if (newNameErr) return textResult(newNameErr);

    const cat = storage.getCategoryByName(name!);
    if (!cat) {
      return textResult(`Category "${name}" not found.`);
    }

    const trimmedNew = newName!.trim();
    const existing = storage.getCategoryByName(trimmedNew);
    if (existing && existing.id !== cat.id) {
      return textResult(`Category "${trimmedNew}" already exists. Choose a different name.`);
    }

    await storage.renameCategory(cat.id, trimmedNew);
    return textResult(
      `Renamed category "${name}" to "${trimmedNew}".\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }

  private async deleteCategory(
    params: ManageToudouParams,
  ): Promise<vscode.LanguageModelToolResult> {
    const { name } = params;

    const nameErr = validateString(name, 'Name', MAX_CATEGORY_LENGTH);
    if (nameErr) return textResult(nameErr);

    const cat = storage.getCategoryByName(name!);
    if (!cat) {
      return textResult(`Category "${name}" not found.`);
    }

    const todosInCategory = storage.getTodosByCategory(cat.id);
    if (todosInCategory.length > 0) {
      return textResult(
        `Cannot delete category "${name}": it still contains ${todosInCategory.length} todo(s). Move or delete them first.`,
      );
    }

    await storage.deleteCategory(cat.id);
    return textResult(
      `Deleted category "${name}".\n\n[Open Toudou panel](command:toudouView.focus)`,
    );
  }
}

// --- Helpers ---

function findTodo(params: { id?: string; title?: string }) {
  if (params.id) return storage.getTodoById(params.id);
  if (params.title) return storage.findTodoByTitle(params.title);
  return undefined;
}
