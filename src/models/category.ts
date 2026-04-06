export interface Category {
  id: string;
  name: string;
  order: number;
  emoji?: string;
}

export function createCategory(name: string, order: number, emoji?: string): Category {
  return {
    id: crypto.randomUUID(),
    name,
    order,
    emoji,
  };
}
