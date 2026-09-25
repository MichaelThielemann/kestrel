import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AtomicOutcome, AtomicScopeInfo, AtomicVerdict } from "@michaelthielemann/kestrel/atomic";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { ModuleHealth } from "@michaelthielemann/kestrel/defineModule";
import { logWarn, silentLogger, type Logger } from "@michaelthielemann/kestrel/logger";
import { err, failure, isErr, ok, type KestrelError, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import { fieldDefinition, type Document, type FieldDefinition, type FieldType, type Filter, type FindOptions, type NewDocument, type Page, type Persistence, type PersistenceError } from "@michaelthielemann/kestrel-contracts/persistence";

export interface Config {
  file: string;
  busyTimeoutMs?: number | undefined;
  acquireTimeoutMs?: number | undefined;
  scopeTimeoutMs?: number | undefined;
}

class AcquireTimeout extends Error {}

class UnusableStore extends Error {
  constructor() {
    super("persistence/sqlite: the store is unusable after a failed rollback; restart the process");
  }
}

function unusableError(): PersistenceError {
  return failure("TRANSIENT", "persistence/sqlite: the store is unusable after a failed rollback; restart the process", {
    details: { reason: "a rollback failed and the connection's state can no longer be proven; the process must be restarted", retryAfterSeconds: 30 },
  });
}

interface ScopeStore {
  state: "open" | "committed" | "rolled-back";
}

type Row = Record<string, unknown>;
type SqlValue = string | number | null;
type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "like";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATORS: Record<Op, string> = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=", in: "IN", like: "LIKE" };
const COLUMN_TYPE: Record<FieldType, string> = { string: "TEXT", number: "REAL", boolean: "INTEGER", json: "TEXT" };

function quote(identifier: string, what: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error(`persistence/sqlite: invalid ${what} "${identifier}"`);
  return `"${identifier}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function persistenceFailure(cause: unknown): PersistenceError | null {
  if (cause instanceof UnusableStore) return unusableError();
  const errcode = isRecord(cause) && typeof cause.errcode === "number" ? cause.errcode : 0;
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

/** `acquireTimeoutMs` when the config sets it, otherwise `busyTimeoutMs` (or its own 5000 default) plus a 10 second margin. */
export function resolveAcquireTimeoutMs(config: Pick<Config, "acquireTimeoutMs" | "busyTimeoutMs">): number {
  return config.acquireTimeoutMs ?? (config.busyTimeoutMs ?? 5000) + 10000;
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

function scopeFailure(cause: unknown, phase: string): KestrelError {
  return persistenceFailure(cause) ?? failure("INTERNAL", `persistence/sqlite: ${phase} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

function execOrFail(db: DatabaseSync, sql: string, phase: string): KestrelError | null {
  try {
    db.exec(sql);
    return null;
  } catch (cause) {
    return scopeFailure(cause, phase);
  }
}

export interface PersistenceSqlite extends Persistence {
  /** Routed through the same mutex as every other call: it waits for an open scope and holds the connection while it runs. */
  checkpoint(): Promise<void>;
  snapshot(file: string): Promise<void>;
  close(): void;
  /** Runs `body` inside `BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`, holding the single connection for its duration. */
  scope(info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome>;
  /** Synchronous, no I/O: `ok: false` only once a rollback has failed and left the connection's state unprovable; never reports lock contention. */
  health(): ModuleHealth;
}

export interface PersistenceSqliteDeps {
  logger?: Logger;
}

export function createPersistenceSqlite(config: Config, deps: PersistenceSqliteDeps = {}): PersistenceSqlite {
  const logger = deps.logger ?? silentLogger;
  if (config.file !== ":memory:") mkdirSync(dirname(config.file), { recursive: true });
  const db = new DatabaseSync(config.file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(config.busyTimeoutMs ?? 5000)}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  const schemas = new Map<string, Record<string, FieldDefinition>>();
  const acquireTimeoutMs = resolveAcquireTimeoutMs(config);
  const defaultScopeTimeoutMs = config.scopeTimeoutMs ?? 5000;
  const als = new AsyncLocalStorage<ScopeStore>();
  let unusable = false;

  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T> | T, acquireMs?: number): Promise<T> => {
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
    if (acquireMs === undefined) return run;
    const abandoned = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        turn = "abandoned";
        reject(new AcquireTimeout());
      }, acquireMs);
      timer.unref?.();
    });
    return Promise.race([run, abandoned]);
  };
  const timedOutWaiting = (): PersistenceError => failure("TRANSIENT", "persistence/sqlite: timed out waiting for the connection");

  const routed = <T>(collection: string, fn: () => Result<T, PersistenceError> | Promise<Result<T, PersistenceError>>): Promise<Result<T, PersistenceError>> => {
    const store = als.getStore();
    if (store?.state === "rolled-back") {
      throw new Error(`persistence/sqlite: the atomic scope was rolled back; this call was not executed (collection "${collection}")`);
    }
    if (store?.state === "open") return Promise.resolve(fn());
    if (unusable) return Promise.resolve(err(unusableError()));
    if (store?.state === "committed") logWarn(logger, "persistence/sqlite: call after the atomic scope committed", { collection });
    return enqueue(() => (unusable ? err(unusableError()) : fn()), acquireTimeoutMs).catch((cause: unknown) => {
      if (cause instanceof AcquireTimeout) return err(timedOutWaiting());
      throw cause;
    });
  };
  const rollbackOrFail = (): PersistenceError | null => {
    const rollbackError = execOrFail(db, "ROLLBACK", "rollback");
    if (rollbackError === null) return null;
    unusable = true;
    logger.error("persistence/sqlite: rollback failed; the store is now unusable", { cause: rollbackError });
    return unusableError();
  };

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
  const decode = <T extends Document>(collection: string, row: Row): T => {
    const out: Row = { id: row.id };
    for (const [field, { type }] of Object.entries(schemaOf(collection))) {
      const v = row[field];
      if (v === null || v === undefined) out[field] = null;
      else if (type === "boolean") out[field] = v === 1;
      else if (type === "json") out[field] = JSON.parse(boundaryCast<string>(v, "host")) as unknown;
      else out[field] = v;
    }
    return boundaryCast<T>(out, "host");
  };

  const where = (collection: string, filter: Filter): { sql: string; params: SqlValue[] } => {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    for (const [field, expected] of Object.entries(filter)) {
      const type = fieldType(collection, field);
      const column = quote(field, "field");
      const condition = isCondition(expected) ? expected : { eq: expected };
      for (const [op, value] of Object.entries(condition)) {
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
          clauses.push(`${column} ${isOperator(op) ? OPERATORS[op] : op} ?`);
          params.push(encode(op === "like" ? "string" : type, value));
        }
      }
    }
    return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
  };

  const selectById = (collection: string, id: string): Result<Document | null, PersistenceError> => {
    const row = run(() => db.prepare(`SELECT * FROM ${quote(collection, "collection")} WHERE "id" = ?`).get(id) as Row | undefined);
    if (isErr(row)) return row;
    return ok(row.value ? decode<Document>(collection, row.value) : null);
  };

  const insert = (collection: string, data: NewDocument<Document>): Result<Document, PersistenceError> => {
    const schema = schemaOf(collection);
    const { id: givenId, ...fields } = data;
    for (const field of Object.keys(fields)) fieldType(collection, field);
    const id = givenId ?? randomUUID();
    const columns = ["id", ...Object.keys(schema)];
    const values: SqlValue[] = [id, ...Object.entries(schema).map(([f, def]) => encode(def.type, fields[f]))];
    const inserted = run(() => db.prepare(`INSERT INTO ${quote(collection, "collection")} (${columns.map((c) => quote(c, "field")).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values));
    if (isErr(inserted)) {
      if (inserted.error.code !== "CONFLICT" || inserted.error.details?.field !== "id") return inserted;
      return err(failure("CONFLICT", `persistence/sqlite: "${collection}/${id}" already exists`, { cause: inserted.error.cause }));
    }
    const row = selectById(collection, id);
    if (isErr(row)) return row;
    return ok(boundaryCast<Document>(row.value, "host"));
  };

  const setClause = (collection: string, patch: Row): { sql: string; params: SqlValue[] } => {
    const entries = Object.entries(patch).filter(([field]) => field !== "id");
    if (entries.length === 0) return { sql: "", params: [] };
    return {
      sql: entries.map(([field]) => `${quote(field, "field")} = ?`).join(", "),
      params: entries.map(([field, value]) => encode(fieldType(collection, field), value)),
    };
  };

  const insertAll = <T extends Document>(collection: string, data: NewDocument<T>[]): Result<T[], PersistenceError> => {
    const out: T[] = [];
    for (const d of data) {
      const created = insert(collection, d);
      if (isErr(created)) return created;
      out.push(boundaryCast<T>(created.value, "host"));
    }
    return ok(out);
  };

  const runScope = async (body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => {
    if (unusable) return { kind: "failed", phase: "begin", error: unusableError() };
    const beginError = execOrFail(db, "BEGIN IMMEDIATE", "begin");
    if (beginError) return { kind: "failed", phase: "begin", error: beginError };

    const store: ScopeStore = { state: "open" };
    let timedOut = false;
    const timer = new Promise<"rollback">((resolve) => {
      const t = setTimeout(() => {
        timedOut = true;
        resolve("rollback");
      }, defaultScopeTimeoutMs);
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

    if (verdict === "commit") {
      const commitError = execOrFail(db, "COMMIT", "commit");
      if (commitError === null) {
        store.state = "committed";
        return { kind: "settled", verdict: "commit" };
      }
      const rollbackError = execOrFail(db, "ROLLBACK", "rollback");
      store.state = "rolled-back";
      if (rollbackError) {
        unusable = true;
        logger.error("persistence/sqlite: rollback after a failed commit also failed; the store is now unusable", { cause: rollbackError, original: commitError });
        return { kind: "failed", phase: "rollback", error: failure("INTERNAL", "persistence/sqlite: rollback after a failed commit also failed", { cause: rollbackError }), original: commitError };
      }
      return { kind: "failed", phase: "commit", error: commitError };
    }

    const rollbackError = execOrFail(db, "ROLLBACK", "rollback");
    store.state = "rolled-back";
    if (rollbackError) {
      unusable = true;
      logger.error("persistence/sqlite: rollback failed; the store is now unusable", { cause: rollbackError });
      return { kind: "failed", phase: "rollback", error: failure("INTERNAL", "persistence/sqlite: rollback failed", { cause: rollbackError }) };
    }
    if (timedOut) return { kind: "failed", phase: "timeout", error: failure("TRANSIENT", "persistence/sqlite: atomic scope timed out") };
    if (didThrow) throw thrown;
    return { kind: "settled", verdict: "rollback" };
  };

  const scope = async (_info: AtomicScopeInfo, body: () => Promise<AtomicVerdict>): Promise<AtomicOutcome> => {
    if (unusable) return { kind: "failed", phase: "begin", error: unusableError() };
    if (als.getStore() !== undefined) {
      return { kind: "failed", phase: "begin", error: failure("INTERNAL", "persistence/sqlite: an atomic scope is already open in this call chain") };
    }
    return enqueue(() => runScope(body), acquireTimeoutMs).catch((cause: unknown): AtomicOutcome => {
      if (cause instanceof AcquireTimeout) return { kind: "failed", phase: "begin", error: timedOutWaiting() };
      throw cause;
    });
  };

  const whenUsable = (fn: () => void) => (): void => {
    if (unusable) throw new UnusableStore();
    fn();
  };

  return {
    checkpoint() {
      const run = () => {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      };
      const store = als.getStore();
      if (store?.state === "open") {
        run();
        return Promise.resolve();
      }
      if (unusable) return Promise.reject(new UnusableStore());
      return enqueue(whenUsable(run));
    },
    snapshot(file) {
      const run = () => {
        mkdirSync(dirname(file), { recursive: true });
        rmSync(file, { force: true });
        db.prepare("VACUUM INTO ?").run(file);
      };
      const store = als.getStore();
      if (store?.state === "open") {
        run();
        return Promise.resolve();
      }
      if (unusable) return Promise.reject(new UnusableStore());
      return enqueue(whenUsable(run));
    },
    close() {
      db.close();
    },
    scope,
    health(): ModuleHealth {
      if (!unusable) return { ok: true };
      return { ok: false, reason: "persistence/sqlite: the store is unusable after a failed rollback", restartRequired: true };
    },

    async ensureCollection(name, schema) {
      if (als.getStore()?.state === "open") throw new Error("persistence/sqlite: ensureCollection must not run inside an atomic scope");
      return routed(name, () => {
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
          const existing = new Set(boundaryCast<Array<{ name: string }>>(db.prepare(`PRAGMA table_info(${table})`).all(), "host").map((c) => c.name));
          for (const [field, { type }] of Object.entries(definitions)) {
            if (!existing.has(field)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${quote(field, "field")} ${COLUMN_TYPE[type]}`);
          }
          const indexes = new Set(boundaryCast<Array<{ name: string }>>(db.prepare(`PRAGMA index_list(${table})`).all(), "host").map((i) => i.name));
          for (const [field, { unique }] of Object.entries(definitions)) {
            const index = uniqueIndexName(name, field);
            if (unique) {
              const duplicate = boundaryCast<{ value: SqlValue; n: number } | undefined>(db.prepare(`SELECT ${quote(field, "field")} AS value, COUNT(*) AS n FROM ${table} WHERE ${quote(field, "field")} IS NOT NULL GROUP BY ${quote(field, "field")} HAVING n > 1 LIMIT 1`).get(), "host");
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
      });
    },

    async createOne<T extends Document>(collection: string, data: NewDocument<T>): Promise<Result<T, PersistenceError>> {
      return routed(collection, () => {
        const created = insert(collection, data);
        if (isErr(created)) return created;
        return ok(boundaryCast<T>(created.value, "host"));
      });
    },

    async createMany<T extends Document>(collection: string, data: NewDocument<T>[]): Promise<Result<T[], PersistenceError>> {
      return routed(collection, () => {
        if (als.getStore()?.state === "open") return insertAll<T>(collection, data);
        const begun = run(() => db.exec("BEGIN IMMEDIATE"));
        if (isErr(begun)) return begun;
        let failed: PersistenceError;
        try {
          const out = insertAll<T>(collection, data);
          if (isErr(out)) {
            failed = out.error;
          } else {
            const committed = run(() => db.exec("COMMIT"));
            if (!isErr(committed)) return out;
            failed = committed.error;
          }
        } catch (cause) {
          rollbackOrFail();
          throw cause;
        }
        return err(rollbackOrFail() ?? failed);
      });
    },

    async findOne<T extends Document>(collection: string, filter: Filter): Promise<Result<T | null, PersistenceError>> {
      return routed(collection, () => {
        const w = where(collection, filter);
        const row = run(() => db.prepare(`SELECT * FROM ${quote(collection, "collection")}${w.sql} LIMIT 1`).get(...w.params) as Row | undefined);
        if (isErr(row)) return row;
        return ok(row.value ? decode<T>(collection, row.value) : null);
      });
    },

    async findMany<T extends Document>(collection: string, filter: Filter, options: FindOptions = {}): Promise<Result<Page<T>, PersistenceError>> {
      return routed(collection, () => {
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
          const total = boundaryCast<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM ${table}${w.sql}`).get(...w.params), "host").n;
          return { items: rows.map((r) => decode<T>(collection, r)), total };
        });
      });
    },

    async count(collection, filter) {
      return routed(collection, () => {
        const w = where(collection, filter);
        return run(() => boundaryCast<{ n: number }>(db.prepare(`SELECT COUNT(*) AS n FROM ${quote(collection, "collection")}${w.sql}`).get(...w.params), "host").n);
      });
    },

    async updateOne<T extends Document>(collection: string, id: string, patch: Partial<Omit<T, "id">>): Promise<Result<T, PersistenceError>> {
      return routed(collection, () => {
        const set = setClause(collection, patch);
        if (set.sql !== "") {
          const updated = run(() => db.prepare(`UPDATE ${quote(collection, "collection")} SET ${set.sql} WHERE "id" = ?`).run(...set.params, id));
          if (isErr(updated)) return updated;
        }
        const doc = selectById(collection, id);
        if (isErr(doc)) return doc;
        if (doc.value === null) return err(failure("NOT_FOUND", `persistence/sqlite: "${collection}/${id}" does not exist`));
        return ok(boundaryCast<T>(doc.value, "host"));
      });
    },

    async updateMany(collection, filter, patch) {
      return routed(collection, () => {
        const set = setClause(collection, patch);
        if (set.sql === "") return ok(0);
        const w = where(collection, filter);
        return run(() => Number(db.prepare(`UPDATE ${quote(collection, "collection")} SET ${set.sql}${w.sql}`).run(...set.params, ...w.params).changes));
      });
    },

    async deleteOne(collection, id) {
      return routed(collection, () => {
        const deleted = run(() => db.prepare(`DELETE FROM ${quote(collection, "collection")} WHERE "id" = ?`).run(id));
        if (isErr(deleted)) return deleted;
        return ok();
      });
    },

    async deleteMany(collection, filter) {
      return routed(collection, () => {
        const w = where(collection, filter);
        return run(() => Number(db.prepare(`DELETE FROM ${quote(collection, "collection")}${w.sql}`).run(...w.params).changes));
      });
    },
  };
}

function isOperator(key: string): key is Op {
  return key in OPERATORS;
}

function isCondition(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] !== undefined && keys[0] in OPERATORS;
}
