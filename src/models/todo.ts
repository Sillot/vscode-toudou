export interface Todo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  order: number;
  createdAt: string;
}

export interface CompletedTodo {
  id: string;
  title: string;
  description: string | undefined;
  categoryId: string | undefined;
  createdAt: string;
  completedAt: string;
}

export function createTodo(
  title: string,
  categoryId?: string,
  description?: string,
  order: number = 0,
): Todo {
  return {
    id: crypto.randomUUID(),
    title,
    description,
    categoryId,
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
    order,
    createdAt: completed.createdAt,
  };
}
