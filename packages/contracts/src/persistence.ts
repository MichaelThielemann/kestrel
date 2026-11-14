import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";
import type { Filter, FindManyOptions, Page, PageWithoutTotal } from "./query.ts";

export type { Condition, Filter, FindManyOptions, FindOptions, Page, PageWithoutTotal } from "./query.ts";

export type FieldType = "string" | "number" | "boolean" | "json";

/** `unique` makes the persistence reject a second document with the same non-null value (`CONFLICT`, `details.field`). */
export interface FieldDefinition {
  type: FieldType;
  unique?: boolean;
}

export type Schema = Record<string, FieldType | FieldDefinition>;

export interface Document {
  id: string;
  [field: string]: unknown;
}

export type NewDocument<T extends Document> = Omit<T, "id"> & { id?: string };

export type PersistenceError = KestrelError<"CONFLICT" | "NOT_FOUND" | "TRANSIENT">;

export interface Persistence {
  ensureCollection(name: string, schema: Schema): Promise<Result<void, PersistenceError>>;

  createOne<T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>>;
  createMany<T extends Document>(collection: string, data: NewDocument<T>[]): Promise<Result<T[], PersistenceError>>;

  findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>>;
  /**
   * The documents matching `filter`, one page of them when `options` limits it. `total` counts every match,
   * not only those on the page; with `withTotal: false` the page has no `total` and nothing is counted, which spares a scan
   * over a large collection when the caller only walks pages.
   */
  findMany<T extends Document>(collection: string, filter: Filter, options: FindManyOptions & { withTotal: false }): Promise<Result<PageWithoutTotal<T>, PersistenceError>>;
  findMany<T extends Document>(collection: string, filter: Filter, options?: FindManyOptions & { withTotal?: true | undefined }): Promise<Result<Page<T>, PersistenceError>>;
  findMany<T extends Document>(collection: string, filter: Filter, options?: FindManyOptions): Promise<Result<PageWithoutTotal<T> & { total?: number }, PersistenceError>>;
  count(collection: string, filter: Filter): Promise<Result<number, PersistenceError>>;

  updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>>;
  updateMany<T extends Document>(collection: string, filter: Filter, patch: Partial<Omit<T, "id">>): Promise<Result<number, PersistenceError>>;

  deleteOne(collection: string, id: string): Promise<Result<void, PersistenceError>>;
  deleteMany(collection: string, filter: Filter): Promise<Result<number, PersistenceError>>;
}

export const PERSISTENCE = defineContract<Persistence>()("persistence@1", ["ensureCollection", "createOne", "createMany", "findOne", "findMany", "count", "updateOne", "updateMany", "deleteOne", "deleteMany"]);
