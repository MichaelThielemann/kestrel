import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createPersistenceSqlite, STATEMENT_CACHE_LIMIT, type PersistenceSqlite } from "./impl.ts";

interface Item {
  id: string;
  name: string;
  n: number;
  [field: string]: unknown;
}

function prepared(): () => string[] {
  const spy = vi.spyOn(DatabaseSync.prototype, "prepare");
  return () => spy.mock.calls.map(([sql]) => sql);
}

async function open(): Promise<PersistenceSqlite> {
  const db = createPersistenceSqlite({ file: ":memory:" });
  expectOk(await db.ensureCollection("items", { name: { type: "string", unique: true }, n: "number" }));
  expectOk(await db.createMany<Item>("items", [1, 2, 3, 4].map((n) => ({ id: `i${n}`, name: `n${n}`, n }))));
  return db;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("persistence/sqlite statement cache", () => {
  it("prepares each SQL form once however often and with whichever values it runs", async () => {
    const db = await open();
    const sqls = prepared();
    for (let round = 0; round < 5; round++) {
      const n = (round % 4) + 1;
      expectOk(await db.findOne<Item>("items", { id: `i${n}` }));
      expectOk(await db.findMany<Item>("items", { n: { gte: n } }, { sort: { n: "asc" }, limit: 2 + round }));
      expectOk(await db.count("items", { n: { gte: n } }));
      expectOk(await db.updateOne<Item>("items", `i${n}`, { n: n + round }));
      expectOk(await db.updateMany<Item>("items", { n: { lt: n } }, { n }));
      expectOk(await db.createOne<Item>("items", { id: `new${round}`, name: `new${round}`, n }));
      expectOk(await db.deleteOne("items", `new${round}`));
      expectOk(await db.deleteMany("items", { name: `absent${round}` }));
    }
    expect(sqls().length).toBeGreaterThan(0);
    expect(new Set(sqls()).size).toBe(sqls().length);
    db.close();
  });

  it("binds LIMIT and OFFSET, so pages of different sizes share one statement", async () => {
    const db = await open();
    const sqls = prepared();
    const names = async (limit: number, offset: number) => expectOk(await db.findMany<Item>("items", {}, { sort: { n: "asc" }, limit, offset })).items.map((x) => x.name);
    expect(await names(1, 0)).toEqual(["n1"]);
    expect(await names(2, 1)).toEqual(["n2", "n3"]);
    expect(await names(3, 3)).toEqual(["n4"]);
    const selects = sqls().filter((sql) => sql.startsWith("SELECT * FROM"));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("LIMIT ? OFFSET ?");
    expect(selects[0]).not.toMatch(/LIMIT \d/);
    db.close();
  });

  it("rejects a limit that is not an integer instead of splicing it into the statement", async () => {
    const db = await open();
    const hostile = "1; DROP TABLE items";
    await expect(db.findMany("items", {}, { limit: boundaryCast<number>(hostile, "host") })).rejects.toThrow();
    expect(expectOk(await db.count("items", {}))).toBe(4);
    db.close();
  });

  it("prepares no COUNT for withTotal: false, and one for a page that needs a count", async () => {
    const db = await open();
    const sqls = prepared();
    const page = expectOk(await db.findMany<Item>("items", {}, { sort: { n: "asc" }, limit: 2, withTotal: false }));
    expect(page.items).toHaveLength(2);
    expect(sqls().some((sql) => sql.includes("COUNT(*)"))).toBe(false);
    expect(expectOk(await db.findMany<Item>("items", {}, { sort: { n: "asc" }, limit: 2 })).total).toBe(4);
    expect(sqls().filter((sql) => sql.includes("COUNT(*)"))).toHaveLength(1);
    db.close();
  });

  it("answers the total of a page that holds every match without counting", async () => {
    const db = await open();
    const sqls = prepared();
    expect(expectOk(await db.findMany<Item>("items", {})).total).toBe(4);
    expect(expectOk(await db.findMany<Item>("items", { n: { gt: 2 } }, { limit: 10 })).total).toBe(2);
    expect(expectOk(await db.findMany<Item>("items", {}, { limit: 2, offset: 4 })).total).toBe(4);
    expect(sqls().filter((sql) => sql.includes("COUNT(*)"))).toHaveLength(1);
    db.close();
  });

  it("keeps at most STATEMENT_CACHE_LIMIT statements, dropping the least recently used", async () => {
    const db = await open();
    const sqls = prepared();
    const byLength = async (length: number) => expectOk(await db.findMany<Item>("items", { id: { in: Array.from({ length }, (_, i) => `i${i}`) } }, { withTotal: false }));
    await byLength(1);
    for (let length = 2; length <= STATEMENT_CACHE_LIMIT; length++) await byLength(length);
    expect(sqls()).toHaveLength(STATEMENT_CACHE_LIMIT);

    await byLength(1);
    expect(sqls()).toHaveLength(STATEMENT_CACHE_LIMIT);
    await byLength(STATEMENT_CACHE_LIMIT + 1);
    expect(sqls()).toHaveLength(STATEMENT_CACHE_LIMIT + 1);

    await byLength(1);
    expect(sqls()).toHaveLength(STATEMENT_CACHE_LIMIT + 1);
    await byLength(2);
    expect(sqls()).toHaveLength(STATEMENT_CACHE_LIMIT + 2);
    db.close();
  });

  it("shows a column added by ensureCollection to reads that ran before", async () => {
    const db = createPersistenceSqlite({ file: ":memory:" });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    expectOk(await db.createOne("t", { id: "1", a: "x" }));
    expect(expectOk(await db.findOne("t", { id: "1" }))).toEqual({ id: "1", a: "x" });
    expect(expectOk(await db.findMany("t", {})).items).toEqual([{ id: "1", a: "x" }]);
    expectOk(await db.ensureCollection("t", { a: "string", b: "number" }));
    expectOk(await db.updateOne("t", "1", { b: 2 }));
    expect(expectOk(await db.findOne("t", { id: "1" }))).toEqual({ id: "1", a: "x", b: 2 });
    expect(expectOk(await db.findMany("t", {})).items).toEqual([{ id: "1", a: "x", b: 2 }]);
    db.close();
  });

  it("keeps a statement usable after a UNIQUE violation", async () => {
    const db = await open();
    expectErr(await db.createOne<Item>("items", { id: "dup", name: "n1", n: 9 }), "CONFLICT");
    expectErr(await db.updateOne<Item>("items", "i2", { name: "n1" }), "CONFLICT");
    expectOk(await db.createOne<Item>("items", { id: "dup", name: "fresh", n: 9 }));
    expectOk(await db.updateOne<Item>("items", "i2", { name: "other" }));
    expect(expectOk(await db.count("items", {}))).toBe(5);
    db.close();
  });

  it("keeps a statement usable after a busy failure", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-"));
    const file = join(dir, "busy.db");
    const db = createPersistenceSqlite({ file, busyTimeoutMs: 0 });
    expectOk(await db.ensureCollection("t", { a: "string" }));
    expectOk(await db.createOne("t", { id: "1", a: "x" }));
    const blocker = new DatabaseSync(file);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      expectErr(await db.createOne("t", { id: "2", a: "y" }), "TRANSIENT");
      expectErr(await db.updateOne("t", "1", { a: "z" }), "TRANSIENT");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expectOk(await db.createOne("t", { id: "2", a: "y" }));
    expectOk(await db.updateOne("t", "1", { a: "z" }));
    expect(expectOk(await db.findMany<{ id: string; a: string }>("t", {}, { sort: { id: "asc" } })).items.map((x) => x.a)).toEqual(["z", "y"]);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a statement usable after a group rolled back", async () => {
    const db = await open();
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      expectOk(await db.createOne<Item>("items", { id: "tmp", name: "tmp", n: 7 }));
      expectOk(await db.updateOne<Item>("items", "i1", { n: 70 }));
      return "rollback";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
    expect(expectOk(await db.findOne<Item>("items", { id: "tmp" }))).toBeNull();
    expect(expectOk(await db.findOne<Item>("items", { id: "i1" }))?.n).toBe(1);
    expectOk(await db.createOne<Item>("items", { id: "tmp", name: "tmp", n: 7 }));
    expectOk(await db.updateOne<Item>("items", "i1", { n: 70 }));
    expect(expectOk(await db.findOne<Item>("items", { id: "i1" }))?.n).toBe(70);
    db.close();
  });

  it("drops its statements on close, so a later call prepares afresh instead of running a stale one", async () => {
    const db = await open();
    expectOk(await db.findOne<Item>("items", { id: "i1" }));
    db.close();
    const sqls = prepared();
    await expect(db.findOne<Item>("items", { id: "i1" })).rejects.toThrow();
    expect(sqls()).toHaveLength(1);
  });
});
