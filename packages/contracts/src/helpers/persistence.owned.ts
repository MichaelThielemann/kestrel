import type { Document, Filter, FindManyOptions, NewDocument, Page, PageWithoutTotal, Persistence, PersistenceError, Schema } from "../persistence.ts";
import type { Result } from "../errors.ts";

/**
 * A view of `db` that reaches only `collections`. Any call naming another collection throws a wiring error
 * that names `owner`, before `db` is asked. For a module whose storage must stay its own: data of another
 * module is read through that module's contract.
 */
export function ownedPersistence(db: Persistence, owner: string, collections: readonly string[]): Persistence {
  const own = new Set(collections);
  const listed = collections.join(", ");
  const assertOwn = (collection: string): void => {
    if (!own.has(collection)) throw new Error(`${owner}: collection "${collection}" is not one of this module's collections (${listed}); read another module's data through its contract`);
  };
  function findMany<T extends Document>(collection: string, filter: Filter, options: FindManyOptions & { withTotal: false }): Promise<Result<PageWithoutTotal<T>, PersistenceError>>;
  function findMany<T extends Document>(collection: string, filter: Filter, options?: FindManyOptions & { withTotal?: true | undefined }): Promise<Result<Page<T>, PersistenceError>>;
  function findMany<T extends Document>(collection: string, filter: Filter, options?: FindManyOptions): Promise<Result<PageWithoutTotal<T> & { total?: number }, PersistenceError>>;
  async function findMany<T extends Document>(collection: string, filter: Filter, options?: FindManyOptions): Promise<Result<PageWithoutTotal<T> & { total?: number }, PersistenceError>> {
    assertOwn(collection);
    return db.findMany<T>(collection, filter, options);
  }
  return {
    async ensureCollection(name: string, schema: Schema) {
      assertOwn(name);
      return db.ensureCollection(name, schema);
    },
    async createOne<T extends Document>(collection: string, data: NewDocument<T>) {
      assertOwn(collection);
      return db.createOne<T>(collection, data);
    },
    async createMany<T extends Document>(collection: string, data: NewDocument<T>[]) {
      assertOwn(collection);
      return db.createMany<T>(collection, data);
    },
    async findOne<T extends Document>(collection: string, filter: Filter) {
      assertOwn(collection);
      return db.findOne<T>(collection, filter);
    },
    findMany,
    async count(collection: string, filter: Filter) {
      assertOwn(collection);
      return db.count(collection, filter);
    },
    async updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>) {
      assertOwn(collection);
      return db.updateOne<T>(collection, id, patch);
    },
    async updateMany<T extends Document>(collection: string, filter: Filter, patch: Partial<Omit<T, "id">>) {
      assertOwn(collection);
      return db.updateMany<T>(collection, filter, patch);
    },
    async deleteOne(collection: string, id: string) {
      assertOwn(collection);
      return db.deleteOne(collection, id);
    },
    async deleteMany(collection: string, filter: Filter) {
      assertOwn(collection);
      return db.deleteMany(collection, filter);
    },
  };
}
