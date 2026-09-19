export type Condition =
  | { eq: unknown }
  | { ne: unknown }
  | { gt: number | string }
  | { gte: number | string }
  | { lt: number | string }
  | { lte: number | string }
  | { in: unknown[] }
  | { like: string };

export type Filter = Record<string, unknown>;

export interface FindOptions {
  sort?: Record<string, "asc" | "desc">;
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
}
