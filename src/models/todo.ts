export type TodoPriority = 'high' | 'medium' | 'low';

export const PRIORITY_ORDER: Record<TodoPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export const NO_PRIORITY_ORDER = 3;

export interface Todo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  priority: TodoPriority | undefined;
  inProgress: boolean | undefined;
  order: number;
  createdAt: string;
}

export interface CompletedTodo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  priority: TodoPriority | undefined;
  createdAt: string;
  completedAt: string;
}

export function createTodo(
  title: string,
  categoryId?: string,
  description?: string,
  order: number = 0,
  priority?: TodoPriority,
): Todo {
  return {
    id: crypto.randomUUID(),
    title,
    description,
    categoryId,
    priority,
    inProgress: undefined,
    order,
    createdAt: new Date().toISOString(),
  };
}

export function completeTodo(todo: Todo): CompletedTodo {
  return {
    id: todo.id,
    title: todo.title,
    description: todo.description,
    categoryId: todo.categoryId,
    priority: todo.priority,
    createdAt: todo.createdAt,
    completedAt: new Date().toISOString(),
  };
}

export function restoreTodo(
  completed: CompletedTodo,
  categoryId: string | undefined,
  order: number,
): Todo {
  return {
    id: completed.id,
    title: completed.title,
    description: completed.description,
    categoryId,
    priority: completed.priority,
    inProgress: undefined,
    order,
    createdAt: completed.createdAt,
  };
}
