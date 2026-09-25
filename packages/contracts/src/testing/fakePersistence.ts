import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { AtomicOutcome, AtomicScopeInfo, AtomicVerdict } from "@michaelthielemann/kestrel/atomic";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { err, failure, ok, type Result } from "../errors.ts";
import { fieldDefinition, type Document, type FieldDefinition, type FieldType, type Filter, type FindOptions, type NewDocument, type Page, type Persistence, type PersistenceError, type Schema } from "../persistence.ts";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;
type Column = FieldType | "id";

const OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "like"]);

function isCondition(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys.every((key) => OPERATORS.has(key));
}

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
    const encoded = encode(column, doc[field]);
    return Object.entries(isCondition(expected) ? expected : { eq: expected }).every(([op, value]) => matchesCondition(column, encoded, op, value));
  });
}

export interface FakePersistence extends Persistence {
  /** Makes the next contract call answer `Err(code)` without touching the store. */
  failNext(code: "TRANSIENT" | "CONFLICT"): void;
  /** Runs `body` with rollback: on "rollback" or a rejection, every write `body` made is undone. */
  scope(info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome>;
  /** Makes the next scope fail in that phase, so a caller can test the commit and rollback paths. */
  failScope(phase: "begin" | "commit" | "rollback"): void;
  /** How long a fake scope may hold the store; the fake's equivalent of `scopeTimeoutMs`. Default 5000. */
  scopeTimeoutMs: number;
  /** How long a call or a scope may wait its turn; the fake's equivalent of `acquireTimeoutMs`. Once it runs out, a call answers `Err(TRANSIENT)` and a scope a failed `begin`, and neither runs afterwards. Default 5000. */
  acquireTimeoutMs: number;
}

class AcquireTimeout extends Error {}

interface FakeScopeStore {
  state: "open" | "committed" | "rolled-back";
}

export function createFakePersistence(): FakePersistence {
  const collections = new Map<string, { schema: Record<string, FieldDefinition>; rows: Map<string, Row> }>();
  let pending: "TRANSIENT" | "CONFLICT" | null = null;
  let pendingScopeFailure: "begin" | "commit" | "rollback" | null = null;
  const als = new AsyncLocalStorage<FakeScopeStore>();
  const inScope = () => als.getStore()?.state === "open";
  const state = { scopeTimeoutMs: 5000, acquireTimeoutMs: 5000 };

  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T> | T): Promise<T> => {
    let turn: "waiting" | "started" | "abandoned" = "waiting";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handOff = (): Promise<T> | T => {
      if (turn === "abandoned") return Promise.reject(new AcquireTimeout());
      turn = "started";
      clearTimeout(timer);
      return fn();
    };
    const run = tail.then(handOff, handOff);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    const abandoned = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        turn = "abandoned";
        reject(new AcquireTimeout());
      }, state.acquireTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([run, abandoned]);
  };
  const timedOutWaiting = (): PersistenceError => failure("TRANSIENT", "fakePersistence: timed out waiting for the store");

  const checkScopeState = (collection: string): void => {
    const store = als.getStore();
    if (store?.state === "rolled-back") {
      throw new Error(`fakePersistence: the atomic scope was rolled back; this call was not executed (collection "${collection}")`);
    }
    if (store?.state === "committed") console.warn("fakePersistence: call after the atomic scope committed");
  };
  const routed = <T>(collection: string, fn: () => Result<T, PersistenceError>): Promise<Result<T, PersistenceError>> => {
    try {
      checkScopeState(collection);
      if (inScope()) return Promise.resolve(fn());
      return enqueue(fn).catch((cause: unknown) => {
        if (cause instanceof AcquireTimeout) return err(timedOutWaiting());
        throw cause;
      });
    } catch (cause) {
      return Promise.reject(cause instanceof Error ? cause : new Error(String(cause)));
    }
  };
  const snapshotCollections = () => new Map([...collections].map(([name, c]) => [name, { schema: c.schema, rows: new Map(c.rows) }]));
  const restoreCollections = (snapshot: Map<string, { schema: Record<string, FieldDefinition>; rows: Map<string, Row> }>) => {
    collections.clear();
    for (const [name, c] of snapshot) collections.set(name, c);
  };
  const clone = <T>(v: T): T => structuredClone(v);
  const cloneAs = <T>(row: Row): T => boundaryCast<T>(clone(row), "host");
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
  const selectEntries = (collection: string, filter: Filter): Array<[string, Row]> => {
    const { schema, rows } = table(collection);
    return [...rows.entries()].filter(([, row]) => matchesFilter(row, filter, schema));
  };
  const select = (collection: string, filter: Filter): Row[] => selectEntries(collection, filter).map(([, row]) => row);
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

  const createOne = <T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>> =>
    routed(collection, () => {
      const injectedError = injected();
      if (injectedError) return err(injectedError);
      const { schema, rows } = table(collection);
      const id = data.id ?? randomUUID();
      if (rows.has(id)) return err(failure("CONFLICT", `fakePersistence: "${collection}/${id}" already exists`));
      const row: Row = { ...Object.fromEntries(Object.keys(schema).map((f) => [f, null])), ...normalize(schema, data), id };
      const violation = uniqueViolation(collection, row, undefined);
      if (violation) return err(violation);
      rows.set(id, row);
      return ok(cloneAs<T>(row));
    });

  const runFakeScope = async (body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => {
    const failedPhase = pendingScopeFailure;
    pendingScopeFailure = null;
    if (failedPhase === "begin") return { kind: "failed", phase: "begin", error: failure("TRANSIENT", "fakePersistence: injected begin failure") };
    const snapshot = snapshotCollections();
    const store: FakeScopeStore = { state: "open" };
    let timedOut = false;
    const timer = new Promise<"rollback">((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve("rollback");
      }, state.scopeTimeoutMs);
      t.unref?.();
    });
    let verdict: AtomicVerdict;
    let thrown: unknown;
    let didThrow = false;
    try {
      verdict = await Promise.race([als.run(store, body), timer]);
    } catch (caught) {
      didThrow = true;
      thrown = caught;
      verdict = "rollback";
    }
    if (timedOut) {
      restoreCollections(snapshot);
      store.state = "rolled-back";
      return { kind: "failed", phase: "timeout", error: failure("TRANSIENT", "fakePersistence: atomic scope timed out") };
    }
    if (verdict === "rollback") {
      restoreCollections(snapshot);
      store.state = "rolled-back";
      if (failedPhase === "rollback") return { kind: "failed", phase: "rollback", error: failure("INTERNAL", "fakePersistence: injected rollback failure") };
      if (didThrow) throw thrown;
      return { kind: "settled", verdict: "rollback" };
    }
    if (failedPhase === "commit") {
      restoreCollections(snapshot);
      store.state = "rolled-back";
      return { kind: "failed", phase: "commit", error: failure("INTERNAL", "fakePersistence: injected commit failure") };
    }
    store.state = "committed";
    return { kind: "settled", verdict: "commit" };
  };

  const scope = async (_info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => {
    if (inScope()) {
      return { kind: "failed", phase: "begin", error: failure("INTERNAL", "fakePersistence: an atomic scope is already open in this call chain") };
    }
    return enqueue(() => runFakeScope(body)).catch((cause: unknown): AtomicOutcome => {
      if (cause instanceof AcquireTimeout) return { kind: "failed", phase: "begin", error: timedOutWaiting() };
      throw cause;
    });
  };

  return {
    failNext(code) {
      pending = code;
    },
    failScope(phase) {
      pendingScopeFailure = phase;
    },
    get scopeTimeoutMs() {
      return state.scopeTimeoutMs;
    },
    set scopeTimeoutMs(ms: number) {
      state.scopeTimeoutMs = ms;
    },
    get acquireTimeoutMs() {
      return state.acquireTimeoutMs;
    },
    set acquireTimeoutMs(ms: number) {
      state.acquireTimeoutMs = ms;
    },
    scope,
    ensureCollection(name, schema) {
      if (inScope()) throw new Error("fakePersistence: ensureCollection must not run inside an atomic scope");
      return routed(name, () => {
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
      });
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
    findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>> {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        const [row] = select(collection, filter);
        return ok(row ? cloneAs<T>(row) : null);
      });
    },
    findMany<T extends Document>(collection: string, filter: Filter, options: FindOptions = {}): Promise<Result<Page<T>, PersistenceError>> {
      return routed(collection, () => {
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
        return ok({ items: rows.map((r) => cloneAs<T>(r)), total });
      });
    },
    count(collection, filter) {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        return ok(select(collection, filter).length);
      });
    },
    updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>> {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        const { rows } = table(collection);
        const row = rows.get(id);
        if (!row) return err(failure("NOT_FOUND", `fakePersistence: "${collection}/${id}" does not exist`));
        const next: Row = { ...row, ...normalize(table(collection).schema, patch), id };
        const violation = uniqueViolation(collection, next, id);
        if (violation) return err(violation);
        rows.set(id, next);
        return ok(cloneAs<T>(next));
      });
    },
    updateMany(collection, filter, patch) {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        const { rows } = table(collection);
        const hits = selectEntries(collection, filter);
        const normalized = normalize(table(collection).schema, patch);
        for (const [id, row] of hits) {
          const violation = uniqueViolation(collection, { ...row, ...normalized }, id);
          if (violation) return err(violation);
        }
        for (const [id, row] of hits) rows.set(id, { ...row, ...normalized, id: row.id });
        return ok(hits.length);
      });
    },
    deleteOne(collection, id) {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        table(collection).rows.delete(id);
        return ok();
      });
    },
    deleteMany(collection, filter) {
      return routed(collection, () => {
        const injectedError = injected();
        if (injectedError) return err(injectedError);
        const { rows } = table(collection);
        const hits = selectEntries(collection, filter);
        for (const [id] of hits) rows.delete(id);
        return ok(hits.length);
      });
    },
  };
}
