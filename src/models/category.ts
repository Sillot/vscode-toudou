export interface Category {
  id: string;
  name: string;
  order: number;
}

export function createCategory(name: string, order: number): Category {
  return {
    id: crypto.randomUUID(),
    name,
    order,
  };
}
