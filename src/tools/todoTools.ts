import * as vscode from 'vscode';
import { createTodo } from '../models/todo';
import { createCategory } from '../models/category';
import * as storage from '../services/storageService';

export function registerTodoTools(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.lm.registerTool('toudou_createTodo', new CreateTodoTool()),
    vscode.lm.registerTool('toudou_listTodos', new ListTodosTool()),
    vscode.lm.registerTool('toudou_completeTodo', new CompleteTodoTool()),
    vscode.lm.registerTool('toudou_deleteTodo', new DeleteTodoTool()),
    vscode.lm.registerTool('toudou_createCategory', new CreateCategoryTool()),
    vscode.lm.registerTool('toudou_renameCategory', new RenameCategoryTool()),
  );
}

// --- Create Todo ---

interface CreateTodoParams {
  title: string;
  category?: string;
  description?: string;
}

class CreateTodoTool implements vscode.LanguageModelTool<CreateTodoParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateTodoParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { title, category, description } = options.input;

    let categoryId: string | undefined;
    if (category) {
      const existing = storage.getCategoryByName(category);
      if (existing) {
        categoryId = existing.id;
      } else {
        const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
        const newCat = createCategory(category, maxOrder);
        await storage.addCategory(newCat);
        categoryId = newCat.id;
      }
    }

    const order = storage.getNextOrder(categoryId);
    const todo = createTodo(title, categoryId, description, order);
    await storage.addTodo(todo);

    const catName = categoryId ? storage.getCategoryById(categoryId)?.name : undefined;
    const locationText = catName ? ` in category "${catName}"` : '';
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Created todo "${title}"${locationText} (id: ${todo.id})`),
    ]);
  }
}

// --- List Todos ---

interface ListTodosParams {
  category?: string;
}

class ListTodosTool implements vscode.LanguageModelTool<ListTodosParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ListTodosParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    let todos = storage.getTodos();
    const categories = storage.getCategories();

    if (options.input.category) {
      const cat = storage.getCategoryByName(options.input.category);
      if (!cat) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Category "${options.input.category}" not found.`),
        ]);
      }
      todos = todos.filter((t) => t.categoryId === cat.id);
    }

    if (todos.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No todos found.'),
      ]);
    }

    const lines = todos.map((t) => {
      const cat = categories.find((c) => c.id === t.categoryId);
      const desc = t.description ? ` — ${t.description}` : '';
      return `- [${cat?.name ?? 'Uncategorized'}] ${t.title}${desc} (id: ${t.id})`;
    });

    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(lines.join('\n'))]);
  }
}

// --- Complete Todo ---

interface TodoRefParams {
  id?: string;
  title?: string;
}

class CompleteTodoTool implements vscode.LanguageModelTool<TodoRefParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TodoRefParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const todo = findTodo(options.input);
    if (!todo) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Todo not found.'),
      ]);
    }

    await storage.completeTodoById(todo.id);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Completed todo "${todo.title}".`),
    ]);
  }
}

// --- Delete Todo ---

class DeleteTodoTool implements vscode.LanguageModelTool<TodoRefParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<TodoRefParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const todo = findTodo(options.input);
    if (!todo) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('Todo not found.'),
      ]);
    }

    await storage.deleteTodo(todo.id);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Deleted todo "${todo.title}".`),
    ]);
  }
}

// --- Create Category ---

interface CreateCategoryParams {
  name: string;
}

class CreateCategoryTool implements vscode.LanguageModelTool<CreateCategoryParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<CreateCategoryParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { name } = options.input;

    const existing = storage.getCategoryByName(name);
    if (existing) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Category "${name}" already exists (id: ${existing.id}).`),
      ]);
    }

    const maxOrder = Math.max(...storage.getCategories().map((c) => c.order), -1) + 1;
    const cat = createCategory(name, maxOrder);
    await storage.addCategory(cat);

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Created category "${name}" (id: ${cat.id}).`),
    ]);
  }
}

// --- Rename Category ---

interface RenameCategoryParams {
  name: string;
  newName: string;
}

class RenameCategoryTool implements vscode.LanguageModelTool<RenameCategoryParams> {
  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<RenameCategoryParams>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { name, newName } = options.input;

    const cat = storage.getCategoryByName(name);
    if (!cat) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Category "${name}" not found.`),
      ]);
    }

    await storage.renameCategory(cat.id, newName);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Renamed category "${name}" to "${newName}".`),
    ]);
  }
}

// --- Helpers ---

function findTodo(params: TodoRefParams) {
  if (params.id) {
    return storage.getTodoById(params.id);
  }
  if (params.title) {
    return storage.findTodoByTitle(params.title);
  }
  return undefined;
}
