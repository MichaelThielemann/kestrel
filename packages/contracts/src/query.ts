// The query vocabulary shared by data contracts (`persistence@1`, `content@1`, `site@1`):
// a filter/condition language, find options, and a paged result shape. Declared once here
// so contracts can express queries without depending on `persistence@1` itself.

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
