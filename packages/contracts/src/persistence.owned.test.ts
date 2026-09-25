import { describe, it, expect } from "vitest";
import type { Persistence } from "./persistence.ts";
import { ownedPersistence } from "./persistence.owned.ts";
import { createFakePersistence } from "./testing/fakePersistence.ts";
import { expectOk } from "./testing/result.ts";

const OWN = ["things", "thing_parts"] as const;

async function store() {
  const db = createFakePersistence();
  expectOk(await db.ensureCollection("things", { name: "string" }));
  expectOk(await db.ensureCollection("thing_parts", { thing: "string" }));
  expectOk(await db.ensureCollection("foreign_rows", { name: "string" }));
  expectOk(await db.createOne("foreign_rows", { id: "f1", name: "not mine" }));
  return db;
}

function spied(db: Persistence): { db: Persistence; calls: string[] } {
  const calls: string[] = [];
  const handler: ProxyHandler<Persistence> = {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        calls.push(`${String(property)}:${String(args[0])}`);
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  };
  return { db: new Proxy(db, handler), calls };
}

const foreignCalls: Array<[string, (view: Persistence) => Promise<unknown>]> = [
  ["ensureCollection", (view) => view.ensureCollection("foreign_rows", { name: "string" })],
  ["createOne", (view) => view.createOne("foreign_rows", { name: "x" })],
  ["createMany", (view) => view.createMany("foreign_rows", [{ name: "x" }])],
  ["findOne", (view) => view.findOne("foreign_rows", { id: "f1" })],
  ["findMany", (view) => view.findMany("foreign_rows", {})],
  ["count", (view) => view.count("foreign_rows", {})],
  ["updateOne", (view) => view.updateOne("foreign_rows", "f1", { name: "y" })],
  ["updateMany", (view) => view.updateMany("foreign_rows", {}, { name: "y" })],
  ["deleteOne", (view) => view.deleteOne("foreign_rows", "f1")],
  ["deleteMany", (view) => view.deleteMany("foreign_rows", {})],
];

describe("ownedPersistence", () => {
  for (const [method, call] of foreignCalls) {
    it(`${method} on another collection throws a wiring error naming the owner, the collection and its own collections, and never reaches the store`, async () => {
      const { db, calls } = spied(await store());
      const view = ownedPersistence(db, "things/default", OWN);
      await expect(call(view)).rejects.toThrow('things/default: collection "foreign_rows" is not one of this module\'s collections (things, thing_parts); read another module\'s data through its contract');
      expect(calls).toEqual([]);
    });
  }

  it("covers every method of persistence@1", () => {
    expect(foreignCalls.map(([method]) => method).sort()).toEqual(["count", "createMany", "createOne", "deleteMany", "deleteOne", "ensureCollection", "findMany", "findOne", "updateMany", "updateOne"]);
  });

  it("passes the arguments and results of its own collections through unchanged", async () => {
    const { db, calls } = spied(await store());
    const view = ownedPersistence(db, "things/default", OWN);
    expectOk(await view.ensureCollection("things", { name: "string" }));
    const one = expectOk(await view.createOne("things", { id: "t1", name: "first" }));
    expect(one).toEqual({ id: "t1", name: "first" });
    expect(expectOk(await view.createMany("thing_parts", [{ id: "p1", thing: "t1" }, { id: "p2", thing: "t1" }])).map((row) => row.id)).toEqual(["p1", "p2"]);
    expect(expectOk(await view.findOne("things", { id: "t1" }))).toEqual({ id: "t1", name: "first" });
    expect(expectOk(await view.findMany("thing_parts", { thing: "t1" }, { sort: { id: "desc" }, limit: 1 })).items.map((row) => row.id)).toEqual(["p2"]);
    expect(expectOk(await view.count("thing_parts", {}))).toBe(2);
    expect(expectOk(await view.updateOne("things", "t1", { name: "renamed" }))).toEqual({ id: "t1", name: "renamed" });
    expect(expectOk(await view.updateMany("thing_parts", { id: "p1" }, { thing: "t2" }))).toBe(1);
    expectOk(await view.deleteOne("thing_parts", "p2"));
    expect(expectOk(await view.deleteMany("thing_parts", {}))).toBe(1);
    expect(calls).toEqual([
      "ensureCollection:things",
      "createOne:things",
      "createMany:thing_parts",
      "findOne:things",
      "findMany:thing_parts",
      "count:thing_parts",
      "updateOne:things",
      "updateMany:thing_parts",
      "deleteOne:thing_parts",
      "deleteMany:thing_parts",
    ]);
  });

  it("passes an error result of the store through as it is", async () => {
    const db = await store();
    const view = ownedPersistence(db, "things/default", OWN);
    db.failNext("TRANSIENT");
    const failed = await view.count("things", {});
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("TRANSIENT");
  });

  it("joins an atomic scope that is open around it", async () => {
    const db = await store();
    const view = ownedPersistence(db, "things/default", OWN);
    const outcome = await db.scope({ pipeline: "p", group: 1 }, async () => {
      expectOk(await view.createOne("things", { id: "t9", name: "inside" }));
      expect(expectOk(await view.findOne("things", { id: "t9" }))).not.toBeNull();
      return "rollback";
    });
    expect(outcome).toEqual({ kind: "settled", verdict: "rollback" });
    expect(expectOk(await db.findOne("things", { id: "t9" }))).toBeNull();
  });
});
