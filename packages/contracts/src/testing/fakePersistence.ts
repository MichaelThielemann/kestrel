import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { err, failure, ok, type Result } from "../errors.ts";
import { fieldDefinition, type Document, type FieldDefinition, type FieldType, type Filter, type FindOptions, type NewDocument, type Page, type Persistence, type PersistenceError, type Schema } from "../persistence.ts";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;
type Column = FieldType | "id";

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "like"]);

function isCondition(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && OPERATORS.has(keys[0] as string);
}

// Without a schema (standalone matchesFilter) the column type is inferred from the stored value.
function columnOf(schema: Schema | undefined, field: string, value: unknown): Column {
  if (field === "id") return "id";
  const declared = schema?.[field];
  if (declared) return fieldDefinition(declared).type;
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "json";
}

function encode(column: Column, value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  switch (column) {
    case "id":
    case "string":
      if (typeof value === "string") return value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      throw new Error(`fakePersistence: expected a string, got ${typeof value}`);
    case "number":
      return Number(value);
    case "boolean":
      return value ? 1 : 0;
    case "json":
      return JSON.stringify(value);
  }
}

// SQLite renders a REAL as %!.15g: always a fractional digit, exponential below 1e-4.
function realText(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "Inf" : "-Inf";
  const [mantissa = "", exponent] = (value !== 0 && Math.abs(value) < 1e-4 ? value.toExponential(14) : value.toPrecision(15)).split("e");
  const digits = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, ".0") : `${mantissa}.0`;
  return exponent === undefined ? digits : `${digits}e${exponent.startsWith("-") ? "-" : "+"}${exponent.replace(/^[+-]/, "").padStart(2, "0")}`;
}

function sqlText(column: Column, value: SqlValue): string | null {
  if (value === null) return null;
  return column === "number" && typeof value === "number" ? realText(value) : String(value);
}

function compare(a: SqlValue, b: SqlValue): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  return Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
}

function compareNullable(a: SqlValue, b: SqlValue): number {
  if (a === null) return b === null ? 0 : -1;
  if (b === null) return 1;
  return compare(a, b);
}

// LIKE folds case for ASCII letters only.
function likeToRegExp(pattern: string): RegExp {
  const literal = (ch: string) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const source = [...pattern].map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : literal(ch))).join("");
  return new RegExp(`^${source}$`, "su");
}

function matchesCondition(column: Column, actual: SqlValue, op: string, expected: unknown): boolean {
  if (op === "in") {
    if (!Array.isArray(expected) || actual === null) return false;
    return expected.some((v) => {
      const item = encode(column, v);
      return item !== null && compare(actual, item) === 0;
    });
  }
  if (op === "like") {
    const pattern = encode("string", expected);
    const value = sqlText(column, actual);
    return typeof pattern === "string" && value !== null && likeToRegExp(pattern).test(value);
  }
  const value = encode(column, expected);
  if (op === "eq" || op === "ne") {
    if (value === null) return (actual === null) === (op === "eq");
    if (actual === null) return false;
    return (compare(actual, value) === 0) === (op === "eq");
  }
  if (actual === null || value === null) return false;
  const order = compare(actual, value);
  switch (op) {
    case "gt":
      return order > 0;
    case "gte":
      return order >= 0;
    case "lt":
      return order < 0;
    case "lte":
      return order <= 0;
    default:
      throw new Error(`fakePersistence: unknown operator "${op}"`);
  }
}

export function matchesFilter(doc: Row, filter: Filter, schema?: Schema): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    if (schema && field !== "id" && !(field in schema)) throw new Error(`fakePersistence: unknown field "${field}"`);
    const column = columnOf(schema, field, doc[field]);
    const [op, value] = Object.entries(isCondition(expected) ? expected : { eq: expected })[0] as [string, unknown];
    return matchesCondition(column, encode(column, doc[field]), op, value);
  });
}

export interface FakePersistence extends Persistence {
  /** Makes the next contract call answer `Err(code)` without touching the store. */
  failNext(code: "TRANSIENT" | "CONFLICT"): void;
}

export function createFakePersistence(): FakePersistence {
  const collections = new Map<string, { schema: Record<string, FieldDefinition>; rows: Map<string, Row> }>();
  let pending: "TRANSIENT" | "CONFLICT" | null = null;
  const clone = <T>(v: T): T => structuredClone(v);
  const injected = (): PersistenceError | null => {
    if (pending === null) return null;
    const code = pending;
    pending = null;
    return failure(code, `fakePersistence: injected ${code}`);
  };
  const table = (name: string) => {
    const c = collections.get(name);
    if (!c) throw new Error(`fakePersistence: unknown collection "${name}"`);
    return c;
  };
  const select = (collection: string, filter: Filter): Row[] => {
    const { schema, rows } = table(collection);
    return [...rows.values()].filter((row) => matchesFilter(row, filter, schema));
  };
  const sortKey = (schema: Schema, field: string, row: Row): SqlValue => {
    if (field !== "id" && !(field in schema)) throw new Error(`fakePersistence: unknown field "${field}"`);
    return encode(columnOf(schema, field, row[field]), row[field]);
  };
  const uniqueViolation = (collection: string, row: Row, exceptId: string | undefined): PersistenceError | null => {
    const { schema, rows } = table(collection);
    for (const [field, { type, unique }] of Object.entries(schema)) {
      if (!unique) continue;
      const value = encode(type, row[field]);
      if (value === null) continue;
      for (const other of rows.values()) {
        if (other.id === exceptId) continue;
        const stored = encode(type, other[field]);
        if (stored !== null && compare(stored, value) === 0) return failure("CONFLICT", `fakePersistence: "${collection}.${field}" must be unique`, { details: { collection, field } });
      }
    }
    return null;
  };
  const normalize = (schema: Schema, patch: Row): Row => {
    const out: Row = {};
    for (const [field, value] of Object.entries(patch)) {
      if (field !== "id" && !(field in schema)) throw new Error(`fakePersistence: unknown field "${field}"`);
      out[field] = value === undefined ? null : clone(value);
    }
    return out;
  };

  const createOne = async <T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>> => {
    const injectedError = injected();
    if (injectedError) return err(injectedError);
    const { schema, rows } = table(collection);
    const id = data.id ?? randomUUID();
    if (rows.has(id)) return err(failure("CONFLICT", `fakePersistence: "${collection}/${id}" already exists`));
    const row: Row = { ...Object.fromEntries(Object.keys(schema).map((f) => [f, null])), ...normalize(schema, data), id };
    const violation = uniqueViolation(collection, row, undefined);
    if (violation) return err(violation);
    rows.set(id, row);
    return ok(clone(row) as T);
  };

  return {
    failNext(code) {
      pending = code;
    },
    async ensureCollection(name, schema) {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      if ("id" in schema) throw new Error(`fakePersistence: "id" is implicit and must not be declared in the schema of "${name}"`);
      const definitions = Object.fromEntries(Object.entries(schema).map(([field, raw]) => [field, clone(fieldDefinition(raw))]));
      const existing = collections.get(name);
      for (const [field, { type, unique }] of Object.entries(definitions)) {
        if (!unique || !existing) continue;
        const seen = new Map<SqlValue, number>();
        for (const row of existing.rows.values()) {
          const value = encode(type, row[field]);
          if (value !== null) seen.set(value, (seen.get(value) ?? 0) + 1);
        }
        const duplicate = [...seen].find(([, n]) => n > 1);
        if (duplicate) throw new Error(`fakePersistence: cannot make "${name}.${field}" unique: value ${JSON.stringify(duplicate[0])} is stored ${duplicate[1]} times`);
      }
      if (existing) existing.schema = definitions;
      else collections.set(name, { schema: definitions, rows: new Map() });
      return ok();
    },
    createOne,
    async createMany(collection, data) {
      const out = [];
      for (const d of data) {
        const created = await createOne(collection, d);
        if (!created.ok) {
          for (const inserted of out) table(collection).rows.delete(inserted.id);
          return created;
        }
        out.push(created.value);
      }
      return ok(out);
    },
    async findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>> {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const [row] = select(collection, filter);
      return ok(row ? (clone(row) as T) : null);
    },
    async findMany<T extends Document>(collection: string, filter: Filter, options: FindOptions = {}): Promise<Result<Page<T>, PersistenceError>> {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const { schema } = table(collection);
      let rows = select(collection, filter);
      const total = rows.length;
      for (const [field, dir] of Object.entries(options.sort ?? {}).reverse()) {
        rows = [...rows].sort((a, b) => (dir === "asc" ? 1 : -1) * compareNullable(sortKey(schema, field, a), sortKey(schema, field, b)));
      }
      const offset = options.offset ?? 0;
      rows = rows.slice(offset, options.limit === undefined ? undefined : offset + options.limit);
      return ok({ items: rows.map((r) => clone(r) as T), total });
    },
    async count(collection, filter) {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      return ok(select(collection, filter).length);
    },
    async updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>> {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const { rows } = table(collection);
      const row = rows.get(id);
      if (!row) return err(failure("NOT_FOUND", `fakePersistence: "${collection}/${id}" does not exist`));
      const next: Row = { ...row, ...normalize(table(collection).schema, patch), id };
      const violation = uniqueViolation(collection, next, id);
      if (violation) return err(violation);
      rows.set(id, next);
      return ok(clone(next) as T);
    },
    async updateMany(collection, filter, patch) {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const { rows } = table(collection);
      const hits = select(collection, filter);
      const normalized = normalize(table(collection).schema, patch);
      for (const row of hits) {
        const violation = uniqueViolation(collection, { ...row, ...normalized }, row.id as string);
        if (violation) return err(violation);
      }
      for (const row of hits) rows.set(row.id as string, { ...row, ...normalized, id: row.id });
      return ok(hits.length);
    },
    async deleteOne(collection, id) {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      table(collection).rows.delete(id);
      return ok();
    },
    async deleteMany(collection, filter) {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const { rows } = table(collection);
      const hits = select(collection, filter);
      for (const row of hits) rows.delete(row.id as string);
      return ok(hits.length);
    },
  };
}
