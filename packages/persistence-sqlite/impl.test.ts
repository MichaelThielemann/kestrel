import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { persistenceContractTests } from "@michaelthielemann/kestrel-contracts/persistence.contract.test";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { isOk, type Result } from "@michaelthielemann/kestrel/result";
import { createPersistenceSqlite, type PersistenceSqlite } from "./impl.ts";
import module from "./module.ts";

persistenceContractTests(async () => createPersistenceSqlite({ file: ":memory:" }));

describe("persistence/sqlite", () => {
  it("rejects unsafe identifiers", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    await expect(db.ensureCollection('x"; DROP TABLE y; --', {})).rejects.toThrow(/invalid collection/);
    await expect(db.ensureCollection("ok", { "bad name": "string" })).rejects.toThrow(/invalid field/);
  });

  it("rejects unknown fields loudly", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    await expect(db.createOne("t", { a: "x", b: "y" })).rejects.toThrow(/unknown field "b"/);
    await expect(db.findMany("t", { b: 1 })).rejects.toThrow(/unknown field "b"/);
  });

  it("ensureCollection adds new columns to an existing table", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    expectOk(await db.createOne("t", { id: "1", a: "x" }));
    expectOk(await db.ensureCollection("t", { a: "string", b: "number" }));
    expect(expectOk(await db.findOne("t", { id: "1" }))).toEqual({ id: "1", a: "x", b: null });
  });

  it("null and boolean round-trip", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string", f: "boolean" }));
    expectOk(await db.createOne("t", { id: "1", a: null, f: true }));
    expect(expectOk(await db.findOne("t", { a: null }))).toEqual({ id: "1", a: null, f: true });
    expect(expectOk(await db.count("t", { a: { ne: null } }))).toBe(0);
    expect(expectOk(await db.count("t", { f: true }))).toBe(1);
  });

  it("checkpoint folds the WAL into the main file", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-"));
    const file = join(dir, "t.db");
    const db = createPersistenceSqlite({ file });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    for (let i = 0; i < 50; i++) expectOk(await db.createOne("t", { a: "x".repeat(500) }));
    const before = statSync(file).size;
    db.checkpoint();
    expect(statSync(file).size).toBeGreaterThan(before);
    expect(statSync(`${file}-wal`).size).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("snapshot writes a consistent, openable copy", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-"));
    const db = createPersistenceSqlite({ file: join(dir, "live.db") });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    expectOk(await db.createOne("t", { id: "1", a: "x" }));
    db.snapshot(join(dir, "snap", "copy.db"));
    const copy = createPersistenceSqlite({ file: join(dir, "snap", "copy.db") });
    expectOk(await copy.ensureCollection("t", { a: "string" }));
    expect(expectOk(await copy.findOne("t", { id: "1" }))).toEqual({ id: "1", a: "x" });
    db.snapshot(join(dir, "snap", "copy.db"));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a locked database is TRANSIENT after busy_timeout, not a throw", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-"));
    const file = join(dir, "locked.db");
    const setup = createPersistenceSqlite({ file });
    expectOk(await setup.ensureCollection("t", { a: "string" }));
    setup.close();

    const write = async (busyTimeoutMs: number): Promise<number> => {
      const blocker = new DatabaseSync(file);
      blocker.exec("PRAGMA journal_mode = WAL");
      blocker.exec("BEGIN IMMEDIATE");
      const db = createPersistenceSqlite({ file, busyTimeoutMs });
      expectOk(await db.ensureCollection("t", { a: "string" }));
      const started = Date.now();
      try {
        const error = expectErr(await db.createOne("t", { a: "x" }), "TRANSIENT");
        expect(error.status).toBe(503);
        expect(error.retryable).toBe(true);
        expect(error.details).toEqual({ retryAfterSeconds: 1 });
        return Date.now() - started;
      } finally {
        db.close();
        blocker.exec("ROLLBACK");
        blocker.close();
      }
    };

    expect(await write(0)).toBeLessThan(150);
    expect(await write(400)).toBeGreaterThanOrEqual(350);
    rmSync(dir, { recursive: true, force: true });
  });

  it("createMany is atomic and reports the duplicate as CONFLICT", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    const error = expectErr(await db.createMany("t", [{ id: "1", a: "x" }, { id: "1", a: "y" }]), "CONFLICT");
    expect(error.message).toMatch(/already exists/);
    expect(error.status).toBe(409);
    expect(expectOk(await db.count("t", {}))).toBe(0);
  });
});

const ctx = (params: Record<string, string> = {}, payload: Record<string, unknown> = {}): Context => createContext({ trigger: { kind: "http", name: "t" }, params, payload });

const stepsOf = (db: PersistenceSqlite) => module.steps!(db);

/** The steps take the module's own instance, so the fake needs the three maintenance calls too. */
function fakeDb(): PersistenceSqlite & { failNext(code: "TRANSIENT" | "CONFLICT"): void } {
  return Object.assign(createFakePersistence(), { checkpoint: () => {}, snapshot: () => {}, close: () => {} });
}

describe("persistence/sqlite steps", () => {
  it("findOne answers NOT_FOUND, updateOne and deleteOne VALIDATION without an id", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    expectOk(await db.createOne("t", { id: "1", a: "x" }));
    const steps = stepsOf(db);

    const found = await steps.findOne("t")(ctx({ id: "1" }));
    expect(isOk(found) && found.value.result).toEqual({ id: "1", a: "x" });
    expectErr(await steps.findOne("t")(ctx({ id: "nope" })), "NOT_FOUND");
    expectErr(await steps.updateOne("t")(ctx()), "VALIDATION");
    expectErr(await steps.deleteOne("t")(ctx()), "VALIDATION");
    expectErr(await steps.updateOne("t")(ctx({ id: "nope" }, { a: "y" })), "NOT_FOUND");
    expectErr(await steps.createOne("t")(ctx({}, { id: "1", a: "z" })), "CONFLICT");
    db.close();
  });

  it("every contract-backed step propagates a transient failure as a retryable 503", async () => {
    const db = fakeDb();
    expectOk(await db.ensureCollection("t", { a: "string" }));
    const steps = stepsOf(db);
    const calls: Array<() => Promise<Result<Context, KestrelError>>> = [
      () => steps.createOne("t")(ctx({}, { a: "x" })),
      () => steps.findOne("t")(ctx({ id: "1" })),
      () => steps.findMany("t")(ctx()),
      () => steps.updateOne("t")(ctx({ id: "1" }, { a: "y" })),
      () => steps.deleteOne("t")(ctx({ id: "1" })),
    ];
    for (const call of calls) {
      db.failNext("TRANSIENT");
      const error = expectErr(await call(), "TRANSIENT");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });

  it("checkpoint and snapshot report a busy database as TRANSIENT and rethrow anything else", async () => {
    const busy = Object.assign(new Error("persistence/sqlite: locked"), { errcode: 261 });
    const steps = stepsOf(
      Object.assign(createFakePersistence(), {
        checkpoint: () => {
          throw busy;
        },
        snapshot: () => {
          throw new Error("boom");
        },
        close: () => {},
      }),
    );
    expectErr(await steps.checkpoint(ctx()), "TRANSIENT");
    await expect(steps.snapshot("copy.db")(ctx())).rejects.toThrow(/boom/);
  });
});
