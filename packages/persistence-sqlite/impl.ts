import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { err, failure, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { fieldDefinition, type Document, type FieldDefinition, type FieldType, type Filter, type FindOptions, type NewDocument, type Page, type Persistence, type PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";

export interface Config {
  file: string;
  busyTimeoutMs?: number | undefined;
}

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATORS: Record<string, string> = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "IN", like: "LIKE" };
const COLUMN_TYPE: Record<FieldType, string> = { string: "TEXT", number: "REAL", boolean: "INTEGER", json: "TEXT" };

function quote(identifier: string, what: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error(`persistence/sqlite: invalid ${what} "${identifier}"`);
  return `"${identifier}"`;
}

// node:sqlite reports the *extended* result code in `errcode` (a primary-key collision is 1555);
// masking with 0xff yields the primary code: 5 SQLITE_BUSY, 6 SQLITE_LOCKED, 19 SQLITE_CONSTRAINT.
export function persistenceFailure(cause: unknown): PersistenceError | null {
  const errcode = typeof cause === "object" && cause !== null && typeof (cause as { errcode?: unknown }).errcode === "number" ? (cause as { errcode: number }).errcode : 0;
  const primary = errcode & 0xff;
  if (primary === 5 || primary === 6) return failure("TRANSIENT", "persistence/sqlite: database is busy", { cause, details: { retryAfterSeconds: 1 } });
  if (primary === 19 && cause instanceof Error && cause.message.includes("UNIQUE constraint failed")) {
    const hit = /UNIQUE constraint failed: ([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/.exec(cause.message);
    const details = hit ? { collection: hit[1], field: hit[2] } : undefined;
    return failure("CONFLICT", hit ? `persistence/sqlite: "${hit[1]}.${hit[2]}" must be unique` : cause.message, { cause, ...(details === undefined ? {} : { details }) });
  }
  return null;
}

function uniqueIndexName(collection: string, field: string): string {
  return `${collection}_${field}_unique`;
}

function run<T>(fn: () => T): Result<T, PersistenceError> {
  try {
    return ok(fn());
  } catch (cause) {
    const error = persistenceFailure(cause);
    if (error === null) throw cause;
    return err(error);
  }
}

export interface PersistenceSqlite extends Persistence {
  checkpoint(): void;
  snapshot(file: string): void;
  close(): void;
}

export function createPersistenceSqlite(config: Config): PersistenceSqlite {
  if (config.file !== ":memory:") mkdirSync(dirname(config.file), { recursive: true });
  const db = new DatabaseSync(config.file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs ?? 5000)}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  const schemas = new Map<string, Record<string, FieldDefinition>>();

  const schemaOf = (collection: string): Record<string, FieldDefinition> => {
    const schema = schemas.get(collection);
    if (!schema) throw new Error(`persistence/sqlite: unknown collection "${collection}" (call ensureCollection first)`);
    return schema;
  };
  const fieldType = (collection: string, field: string): FieldType | "id" => {
    if (field === "id") return "id";
    const def = schemaOf(collection)[field];
    if (!def) throw new Error(`persistence/sqlite: unknown field "${field}" in collection "${collection}"`);
    return def.type;
  };

  const encode = (type: FieldType | "id", value: unknown): SqlValue => {
    if (value === null || value === undefined) return null;
    switch (type) {
      case "id":
      case "string":
        if (typeof value === "string") return value;
        if (typeof value === "number" || typeof value === "boolean") return String(value);
        throw new Error(`persistence/sqlite: expected a string, got ${typeof value}`);
      case "number":
        return Number(value);
      case "boolean":
        return value ? 1 : 0;
      case "json":
        return JSON.stringify(value);
    }
  };
  const decode = (collection: string, row: Row): Row => {
    const out: Row = { id: row.id };
    for (const [field, { type }] of Object.entries(schemaOf(collection))) {
      const v = row[field];
      if (v === null || v === undefined) out[field] = null;
      else if (type === "boolean") out[field] = v === 1;
      else if (type === "json") out[field] = JSON.parse(v as string) as unknown;
      else out[field] = v;
    }
    return out;
  };

  const where = (collection: string, filter: Filter): { sql: string; params: SqlValue[] } => {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const [field, expected] of Object.entries(filter)) {
      const type = fieldType(collection, field);
      const column = quote(field, "field");
      const condition = isCondition(expected) ? expected : { eq: expected };
      const [op, value] = Object.entries(condition)[0] as [string, unknown];
      if (op === "in") {
        const list = Array.isArray(value) ? value : [];
        if (list.length === 0) {
          clauses.push("0");
          continue;
        }
        clauses.push(`${column} IN (${list.map(() => "?").join(", ")})`);
        params.push(...list.map((v) => encode(type, v)));
      } else if ((op === "eq" || op === "ne") && (value === null || value === undefined)) {
        clauses.push(`${column} IS ${op === "eq" ? "" : "NOT "}NULL`);
      } else {
        clauses.push(`${column} ${OPERATORS[op] as string} ?`);
        params.push(encode(op === "like" ? "string" : type, value));
      }
    }
    return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
  };

  const selectById = (collection: string, id: string): Result<Document | null, PersistenceError> => {
    const row = run(() => db.prepare(`SELECT * FROM ${quote(collection, "collection")} WHERE "id" = ?`).get(id) as Row | undefined);
    if (isErr(row)) return row;
    return ok(row.value ? (decode(collection, row.value) as Document) : null);
  };

  const insert = (collection: string, data: NewDocument<Document>): Result<Document, PersistenceError> => {
    const schema = schemaOf(collection);
    const { id: givenId, ...fields } = data;
    for (const field of Object.keys(fields)) fieldType(collection, field);
    const id = givenId ?? randomUUID();
    const columns = ["id", ...Object.keys(schema)];
    const values: SqlValue[] = [id, ...Object.keys(schema).map((f) => encode((schema[f] as FieldDefinition).type, fields[f]))];
    const inserted = run(() => db.prepare(`INSERT INTO ${quote(collection, "collection")} (${columns.map((c) => quote(c, "field")).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values));
    if (isErr(inserted)) {
      if (inserted.error.code !== "CONFLICT" || inserted.error.details?.field !== "id") return inserted;
      return err(failure("CONFLICT", `persistence/sqlite: "${collection}/${id}" already exists`, { cause: inserted.error.cause }));
    }
    const row = selectById(collection, id);
    if (isErr(row)) return row;
    return ok(row.value as Document);
  };

  const setClause = (collection: string, patch: Row): { sql: string; params: SqlValue[] } => {
    const entries = Object.entries(patch).filter(([field]) => field !== "id");
    if (entries.length === 0) return { sql: "", params: [] };
    return {
      sql: entries.map(([field]) => `${quote(field, "field")} = ?`).join(", "),
      params: entries.map(([field, value]) => encode(fieldType(collection, field), value)),
    };
  };

  return {
    checkpoint() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    snapshot(file) {
      mkdirSync(dirname(file), { recursive: true });
      rmSync(file, { force: true });
      db.prepare("VACUUM INTO ?").run(file);
    },
    close() {
      db.close();
    },

    async ensureCollection(name, schema) {
      const table = quote(name, "collection");
      const definitions: Record<string, FieldDefinition> = {};
      for (const [field, raw] of Object.entries(schema)) {
        if (field === "id") throw new Error(`persistence/sqlite: field "id" is implicit in collection "${name}"`);
        quote(field, "field");
        definitions[field] = fieldDefinition(raw);
      }
      const columns = Object.entries(definitions).map(([f, { type }]) => `${quote(f, "field")} ${COLUMN_TYPE[type]}`);
      const created = run(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS ${table} ("id" TEXT PRIMARY KEY${columns.map((c) => `, ${c}`).join("")})`);
        const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
        for (const [field, { type }] of Object.entries(definitions)) {
          if (!existing.has(field)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${quote(field, "field")} ${COLUMN_TYPE[type]}`);
        }
        const indexes = new Set((db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name));
        for (const [field, { unique }] of Object.entries(definitions)) {
          const index = uniqueIndexName(name, field);
          if (unique) {
            const duplicate = db.prepare(`SELECT ${quote(field, "field")} AS value, COUNT(*) AS n FROM ${table} WHERE ${quote(field, "field")} IS NOT NULL GROUP BY ${quote(field, "field")} HAVING n > 1 LIMIT 1`).get() as { value: SqlValue; n: number } | undefined;
            if (duplicate) throw new Error(`persistence/sqlite: cannot make "${name}.${field}" unique: value ${JSON.stringify(duplicate.value)} is stored ${duplicate.n} times`);
            db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${quote(index, "index")} ON ${table} (${quote(field, "field")})`);
          } else if (indexes.has(index)) {
            db.exec(`DROP INDEX ${quote(index, "index")}`);
          }
        }
      });
      if (isErr(created)) return created;
      schemas.set(name, definitions);
      return ok();
    },

    async createOne<T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>> {
      const created = insert(collection, data);
      if (isErr(created)) return created;
      return ok(created.value as T);
    },

    async createMany<T extends Document>(collection: string, data: NewDocument<T>[]): Promise<Result<T[], PersistenceError>> {
      const begun = run(() => db.exec("BEGIN"));
      if (isErr(begun)) return begun;
      try {
        const out: T[] = [];
        for (const d of data) {
          const created = insert(collection, d);
          if (isErr(created)) {
            db.exec("ROLLBACK");
            return created;
          }
          out.push(created.value as T);
        }
        const committed = run(() => db.exec("COMMIT"));
        if (isErr(committed)) {
          db.exec("ROLLBACK");
          return committed;
        }
        return ok(out);
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },

    async findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>> {
      const w = where(collection, filter);
      const row = run(() => db.prepare(`SELECT * FROM ${quote(collection, "collection")}${w.sql} LIMIT 1`).get(...w.params) as Row | undefined);
      if (isErr(row)) return row;
      return ok(row.value ? (decode(collection, row.value) as T) : null);
    },

    async findMany<T extends Document>(collection: string, filter: Filter, options: FindOptions = {}): Promise<Result<Page<T>, PersistenceError>> {
      const table = quote(collection, "collection");
      const w = where(collection, filter);
      const order = Object.entries(options.sort ?? {}).map(([field, dir]) => {
        fieldType(collection, field);
        return `${quote(field, "field")} ${dir === "desc" ? "DESC" : "ASC"}`;
      });
      let sql = `SELECT * FROM ${table}${w.sql}`;
      if (order.length > 0) sql += ` ORDER BY ${order.join(", ")}`;
      if (options.limit !== undefined || options.offset !== undefined) sql += ` LIMIT ${options.limit ?? -1} OFFSET ${options.offset ?? 0}`;
      return run(() => {
        const rows = db.prepare(sql).all(...w.params) as Row[];
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}${w.sql}`).get(...w.params) as { n: number }).n;
        return { items: rows.map((r) => decode(collection, r) as T), total };
      });
    },

    async count(collection, filter) {
      const w = where(collection, filter);
      return run(() => (db.prepare(`SELECT COUNT(*) AS n FROM ${quote(collection, "collection")}${w.sql}`).get(...w.params) as { n: number }).n);
    },

    async updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>> {
      const set = setClause(collection, patch);
      if (set.sql !== "") {
        const updated = run(() => db.prepare(`UPDATE ${quote(collection, "collection")} SET ${set.sql} WHERE "id" = ?`).run(...set.params, id));
        if (isErr(updated)) return updated;
      }
      const doc = selectById(collection, id);
      if (isErr(doc)) return doc;
      if (doc.value === null) return err(failure("NOT_FOUND", `persistence/sqlite: "${collection}/${id}" does not exist`));
      return ok(doc.value as T);
    },

    async updateMany(collection, filter, patch) {
      const set = setClause(collection, patch);
      if (set.sql === "") return ok(0);
      const w = where(collection, filter);
      return run(() => Number(db.prepare(`UPDATE ${quote(collection, "collection")} SET ${set.sql}${w.sql}`).run(...set.params, ...w.params).changes));
    },

    async deleteOne(collection, id) {
      const deleted = run(() => db.prepare(`DELETE FROM ${quote(collection, "collection")} WHERE "id" = ?`).run(id));
      if (isErr(deleted)) return deleted;
      return ok();
    },

    async deleteMany(collection, filter) {
      const w = where(collection, filter);
      return run(() => Number(db.prepare(`DELETE FROM ${quote(collection, "collection")}${w.sql}`).run(...w.params).changes));
    },
  };
}

function isCondition(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] !== undefined && keys[0] in OPERATORS;
}
