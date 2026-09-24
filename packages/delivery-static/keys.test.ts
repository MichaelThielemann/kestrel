import { describe, expect, it } from "vitest";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import type { Document, Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { dependencyRowId, encodeSegment, scan, setIdOf, statusIdOf } from "./keys.ts";

describe("delivery/static keys", () => {
  it("keeps [A-Za-z0-9._-] and percent-encodes every other UTF-8 byte in upper-case hex", () => {
    expect(encodeSegment("Abc-1_2.x")).toBe("Abc-1_2.x");
    expect(encodeSegment("a/b*c?d")).toBe("a%2Fb%2Ac%3Fd");
    expect(encodeSegment("Größe")).toBe("Gr%C3%B6%C3%9Fe");
    expect(encodeSegment("%")).toBe("%25");
    expect(encodeSegment("a b")).toBe("a%20b");
  });

  it("never lets /, * or ? occur inside a segment", () => {
    for (const raw of ["/", "*", "?", "x/y", "**", "?/*"]) expect(encodeSegment(raw)).not.toMatch(/[/*?]/);
  });

  it("builds the status, set and dependency ids from encoded segments, with - for an unlocalized output", () => {
    expect(statusIdOf("pages", "p/1", "de")).toBe("pages/p%2F1/de");
    expect(statusIdOf("pages", "p1", "")).toBe("pages/p1/-");
    expect(setIdOf("pages", "p1", "en", "r1")).toBe("pages/p1/en/r1");
    expect(dependencyRowId({ kind: "document", depType: "speakers", depId: "s1" }, { type: "pages", docId: "p1", locale: "de" }, "r1", 0)).toBe("speakers/s1/document/pages/p1/de/r1/0");
    expect(dependencyRowId({ kind: "type", depType: "settings", depId: null }, { type: "pages", docId: "p1", locale: "" }, "r1", 3)).toBe("settings/*/type/pages/p1/-/r1/3");
    expect(dependencyRowId({ kind: "query", depType: "speakers", depId: null }, { type: "pages", docId: "p1", locale: "de" }, "r1", 1)).toBe("speakers/?/query/pages/p1/de/r1/1");
  });
});

async function stores(): Promise<Array<[string, Persistence]>> {
  const sqlite = createPersistenceSqlite({ file: ":memory:" });
  return [
    ["fake", createFakePersistence()],
    ["sqlite", sqlite],
  ];
}

describe("delivery/static scan", () => {
  it("returns exactly the rows under a prefix, never those of an adjacent prefix", async () => {
    for (const [name, db] of await stores()) {
      expectOk(await db.ensureCollection("deps", { note: "string" }));
      const ids = ["T/abc/1", "T/abc/2", "T/abcd/1", "T/abc-x/1", "T/ab/1", "T/abc0/1", "T/abc%2F/1", "U/abc/1"];
      expectOk(await db.createMany<Document>("deps", ids.map((id) => ({ id, note: id }))));
      const found = expectOk(await scan<Document>(db, "deps", "T/abc/"));
      expect(found.map((r) => r.id), name).toEqual(["T/abc/1", "T/abc/2"]);
      expect(expectOk(await scan<Document>(db, "deps", "T/abc-x/")).map((r) => r.id), name).toEqual(["T/abc-x/1"]);
      expect(expectOk(await scan<Document>(db, "deps", "T/zzz/")), name).toEqual([]);
    }
  });

  it("continues past a full page of 200 rows", async () => {
    for (const [name, db] of await stores()) {
      expectOk(await db.ensureCollection("deps", { note: "string" }));
      const under = Array.from({ length: 450 }, (_, i) => `T/x/${String(i).padStart(4, "0")}`);
      expectOk(await db.createMany<Document>("deps", [...under, "T/w/1", "T/y/1"].map((id) => ({ id, note: "" }))));
      const found = expectOk(await scan<Document>(db, "deps", "T/x/"));
      expect(found.length, name).toBe(450);
      expect(found.map((r) => r.id), name).toEqual(under);
    }
  });

  it("uses one operator per condition: gte first, then gt from the last id, and stops at the first id outside the prefix", async () => {
    const db = createFakePersistence();
    expectOk(await db.ensureCollection("deps", { note: "string" }));
    const under = Array.from({ length: 201 }, (_, i) => `T/x/${String(i).padStart(3, "0")}`);
    const after = Array.from({ length: 400 }, (_, i) => `T/y/${String(i).padStart(3, "0")}`);
    expectOk(await db.createMany<Document>("deps", [...under, ...after].map((id) => ({ id, note: "" }))));
    const filters: unknown[] = [];
    const spy: Persistence = { ...db, findMany: (collection, filter, options) => (filters.push(filter), db.findMany(collection, filter, options)) };
    expect(expectOk(await scan<Document>(spy, "deps", "T/x/")).length).toBe(201);
    expect(filters).toEqual([{ id: { gte: "T/x/" } }, { id: { gt: "T/x/199" } }]);
  });
});
