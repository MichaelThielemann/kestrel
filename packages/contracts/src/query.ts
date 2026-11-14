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

/** What `Persistence.findMany` accepts beyond the shared query options. */
export interface FindManyOptions extends FindOptions {
  /** `false` returns the page without `total` and runs no count over the matches; `true` and an omitted value count them. */
  withTotal?: boolean;
}

/** A page whose `total` was not requested: the same page, without the count. */
export type PageWithoutTotal<T> = Pick<Page<T>, "items">;
