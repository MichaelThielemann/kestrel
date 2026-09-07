import { describe, it, expect, beforeEach } from "vitest";
import type { Document, Filter, Persistence } from "./persistence.ts";
import { expectErr, expectOk } from "./testing/result.ts";

interface Thing extends Document {
  name: string;
  n: number;
  done: boolean;
  meta: { tags: string[] };
}

export function persistenceContractTests(make: () => Promise<Persistence>) {
  describe("persistence@1", () => {
    let db: Persistence;
    beforeEach(async () => {
      db = await make();
      expectOk(await db.ensureCollection("things", { name: "string", n: "number", done: "boolean", meta: "json" }));
    });

    const seed = () =>
      db.createMany<Thing>("things", [
        { id: "a", name: "alpha", n: 1, done: false, meta: { tags: ["x"] } },
        { id: "b", name: "beta", n: 2, done: true, meta: { tags: [] } },
        { id: "c", name: "gamma", n: 3, done: false, meta: { tags: ["x", "y"] } },
      ]);

    const idsOf = async (filter: Filter) => expectOk(await db.findMany<Thing>("things", filter, { sort: { id: "asc" } })).items.map((d) => d.id);

    it("fills schema fields absent from the stored document with null on every read", async () => {
      expectOk(await db.createOne("things", { id: "bare", name: "bare" }));
      const expected = { id: "bare", name: "bare", n: null, done: null, meta: null };
      expect(expectOk(await db.findOne("things", { id: "bare" }))).toEqual(expected);
      expect(expectOk(await db.findMany("things", { id: "bare" })).items).toEqual([expected]);
      expect(expectOk(await db.updateOne("things", "bare", { n: 7 }))).toEqual({ ...expected, n: 7 });
    });

    it("rejects fields that are not in the schema", async () => {
      expectOk(await seed());
      await expect(db.findMany("things", { bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.findOne("things", { bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.count("things", { bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.findMany("things", {}, { sort: { bogus: "asc" } })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.createOne("things", { name: "x", bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.updateOne("things", "a", { bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
      await expect(db.updateMany("things", {}, { bogus: 1 })).rejects.toThrow(/unknown field "bogus"/);
    });

    it("ensureCollection is idempotent", async () => {
      expect(expectOk(await db.ensureCollection("things", { name: "string", n: "number", done: "boolean", meta: "json" }))).toBeUndefined();
    });

    it("a schema declaring id throws", async () => {
      await expect(db.ensureCollection("with_id", { id: "string", name: "string" })).rejects.toThrow(/id/);
    });

    it("unknown collection throws", async () => {
      await expect(db.findMany("nope", {})).rejects.toThrow();
    });

    it("createOne returns the document with the given id", async () => {
      const doc = expectOk(await db.createOne<Thing>("things", { id: "a", name: "alpha", n: 1, done: false, meta: { tags: [] } }));
      expect(doc).toEqual({ id: "a", name: "alpha", n: 1, done: false, meta: { tags: [] } });
    });

    it("createOne without id generates a unique string id", async () => {
      const x = expectOk(await db.createOne<Thing>("things", { name: "x", n: 0, done: false, meta: { tags: [] } }));
      const y = expectOk(await db.createOne<Thing>("things", { name: "y", n: 0, done: false, meta: { tags: [] } }));
      expect(typeof x.id).toBe("string");
      expect(x.id.length).toBeGreaterThan(0);
      expect(x.id).not.toBe(y.id);
    });

    it("createOne with an existing id is a CONFLICT", async () => {
      expectOk(await seed());
      expectErr(await db.createOne<Thing>("things", { id: "a", name: "dup", n: 0, done: false, meta: { tags: [] } }), "CONFLICT");
    });

    it("createMany returns all documents in order", async () => {
      const docs = expectOk(await seed());
      expect(docs.map((d) => d.id)).toEqual(["a", "b", "c"]);
    });

    it("findOne by id and by field, null when absent", async () => {
      expectOk(await seed());
      expect(expectOk(await db.findOne<Thing>("things", { id: "b" }))?.name).toBe("beta");
      expect(expectOk(await db.findOne<Thing>("things", { name: "gamma" }))?.id).toBe("c");
      expect(expectOk(await db.findOne<Thing>("things", { name: "nope" }))).toBeNull();
    });

    it("findMany with empty filter returns everything with total", async () => {
      expectOk(await seed());
      const page = expectOk(await db.findMany<Thing>("things", {}));
      expect(page.total).toBe(3);
      expect(page.items.map((d) => d.id).sort()).toEqual(["a", "b", "c"]);
    });

    it("findMany combines conditions with AND", async () => {
      expectOk(await seed());
      const page = expectOk(await db.findMany<Thing>("things", { done: false, n: { gte: 2 } }));
      expect(page.items.map((d) => d.id)).toEqual(["c"]);
    });

    it("findMany supports eq, ne, gt, gte, lt, lte, in, like", async () => {
      expectOk(await seed());
      const ids = async (filter: Record<string, unknown>) => expectOk(await db.findMany<Thing>("things", filter, { sort: { n: "asc" } })).items.map((d) => d.id);
      expect(await ids({ n: { eq: 2 } })).toEqual(["b"]);
      expect(await ids({ n: { ne: 2 } })).toEqual(["a", "c"]);
      expect(await ids({ n: { gt: 1 } })).toEqual(["b", "c"]);
      expect(await ids({ n: { gte: 2 } })).toEqual(["b", "c"]);
      expect(await ids({ n: { lt: 2 } })).toEqual(["a"]);
      expect(await ids({ n: { lte: 2 } })).toEqual(["a", "b"]);
      expect(await ids({ name: { in: ["alpha", "gamma"] } })).toEqual(["a", "c"]);
      expect(await ids({ name: { like: "%a" } })).toEqual(["a", "b", "c"]);
      expect(await ids({ name: { like: "g_mma" } })).toEqual(["c"]);
      expect(await ids({ name: { like: "al%" } })).toEqual(["a"]);
    });

    it("like folds ASCII case only", async () => {
      expectOk(await seed());
      expectOk(
        await db.createMany<Thing>("things", [
          { id: "d", name: "Ärger", n: 4, done: false, meta: { tags: [] } },
          { id: "e", name: "ärger", n: 5, done: false, meta: { tags: [] } },
        ]),
      );
      expect(await idsOf({ name: { like: "AL%" } })).toEqual(["a"]);
      expect(await idsOf({ name: { like: "%MM%" } })).toEqual(["c"]);
      expect(await idsOf({ name: { like: "BETA" } })).toEqual(["b"]);
      expect(await idsOf({ name: { like: "Ärger" } })).toEqual(["d"]);
      expect(await idsOf({ name: { like: "ärger" } })).toEqual(["e"]);
      expect(await idsOf({ name: { like: "ÄRGER" } })).toEqual(["d"]);
    });

    it("like applies to the text form of non-string fields", async () => {
      expectOk(await seed());
      expect(await idsOf({ n: { like: "%" } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { like: "%1%" } })).toEqual(["a"]);
      expect(await idsOf({ meta: { like: "%x%" } })).toEqual(["a", "c"]);
    });

    it("a missing field is null and satisfies no operator but eq/ne null", async () => {
      expectOk(await seed());
      expectOk(await db.createOne<Document>("things", { id: "d", name: "delta" }));
      expect(await idsOf({ n: { gt: 0 } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { gte: 0 } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { lt: 99 } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { lte: 99 } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { eq: 1 } })).toEqual(["a"]);
      expect(await idsOf({ n: { ne: 1 } })).toEqual(["b", "c"]);
      expect(await idsOf({ n: { in: [1, 2, 3] } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ n: { like: "%" } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ done: { ne: true } })).toEqual(["a", "c"]);
      expect(await idsOf({ n: null })).toEqual(["d"]);
      expect(await idsOf({ n: { eq: null } })).toEqual(["d"]);
      expect(await idsOf({ n: { ne: null } })).toEqual(["a", "b", "c"]);
      expect(await idsOf({ meta: { eq: null } })).toEqual(["d"]);
    });

    it("filters on a json field compare the value structurally", async () => {
      expectOk(await seed());
      expect(await idsOf({ meta: { tags: ["x"] } })).toEqual(["a"]);
      expect(await idsOf({ meta: { eq: { tags: [] } } })).toEqual(["b"]);
      expect(await idsOf({ meta: { ne: { tags: ["x"] } } })).toEqual(["b", "c"]);
      expect(await idsOf({ meta: { in: [{ tags: [] }, { tags: ["x", "y"] }] } })).toEqual(["b", "c"]);
    });

    it("in matches string, number, boolean and json values exactly", async () => {
      expectOk(await seed());
      expect(await idsOf({ id: { in: ["a", "c"] } })).toEqual(["a", "c"]);
      expect(await idsOf({ name: { in: ["alpha", "gamma"] } })).toEqual(["a", "c"]);
      expect(await idsOf({ name: { in: ["ALPHA"] } })).toEqual([]);
      expect(await idsOf({ n: { in: [1, 3] } })).toEqual(["a", "c"]);
      expect(await idsOf({ done: { in: [true] } })).toEqual(["b"]);
      expect(await idsOf({ meta: { in: [{ tags: ["x"] }] } })).toEqual(["a"]);
      expect(await idsOf({ n: { in: [] } })).toEqual([]);
    });

    it("findMany sorts, limits and offsets while total stays the full count", async () => {
      expectOk(await seed());
      const page = expectOk(await db.findMany<Thing>("things", {}, { sort: { n: "desc" }, limit: 2, offset: 1 }));
      expect(page.total).toBe(3);
      expect(page.items.map((d) => d.id)).toEqual(["b", "a"]);
    });

    it("findMany sorts strings", async () => {
      expectOk(await seed());
      const page = expectOk(await db.findMany<Thing>("things", {}, { sort: { name: "desc" } }));
      expect(page.items.map((d) => d.name)).toEqual(["gamma", "beta", "alpha"]);
    });

    it("findMany sorts strings by binary collation, not by locale", async () => {
      expectOk(await db.createMany<Document>("things", [{ id: "1", name: "alpha" }, { id: "2", name: "Beta" }, { id: "3", name: "Zulu" }, { id: "4", name: "apple" }]));
      const page = expectOk(await db.findMany<Thing>("things", {}, { sort: { name: "asc" } }));
      expect(page.items.map((d) => d.name)).toEqual(["Beta", "Zulu", "alpha", "apple"]);
    });

    it("findMany sorts null fields first ascending and last descending", async () => {
      expectOk(await seed());
      expectOk(await db.createOne<Document>("things", { id: "d", name: "delta" }));
      const order = async (dir: "asc" | "desc") => expectOk(await db.findMany<Thing>("things", {}, { sort: { n: dir } })).items.map((x) => x.id);
      expect(await order("asc")).toEqual(["d", "a", "b", "c"]);
      expect(await order("desc")).toEqual(["c", "b", "a", "d"]);
      expect(expectOk(await db.findMany<Thing>("things", {}, { sort: { done: "asc", id: "asc" } })).items.map((x) => x.id)).toEqual(["d", "a", "c", "b"]);
    });

    it("json fields round-trip", async () => {
      expectOk(await seed());
      expect(expectOk(await db.findOne<Thing>("things", { id: "c" }))?.meta).toEqual({ tags: ["x", "y"] });
    });

    it("count", async () => {
      expectOk(await seed());
      expect(expectOk(await db.count("things", {}))).toBe(3);
      expect(expectOk(await db.count("things", { done: false }))).toBe(2);
    });

    it("updateOne merges, keeps id and returns the document", async () => {
      expectOk(await seed());
      const doc = expectOk(await db.updateOne<Thing>("things", "a", { n: 10 }));
      expect(doc).toEqual({ id: "a", name: "alpha", n: 10, done: false, meta: { tags: ["x"] } });
      expect(expectOk(await db.findOne<Thing>("things", { id: "a" }))?.n).toBe(10);
    });

    it("updateOne of unknown id is NOT_FOUND", async () => {
      expectErr(await db.updateOne<Thing>("things", "missing", { n: 1 }), "NOT_FOUND");
    });

    it("updateMany returns the number of changed documents", async () => {
      expectOk(await seed());
      expect(expectOk(await db.updateMany<Thing>("things", { done: false }, { done: true }))).toBe(2);
      expect(expectOk(await db.count("things", { done: true }))).toBe(3);
      expect(expectOk(await db.updateMany<Thing>("things", { name: "nope" }, { done: false }))).toBe(0);
    });

    it("deleteOne removes and is idempotent", async () => {
      expectOk(await seed());
      expectOk(await db.deleteOne("things", "a"));
      expect(expectOk(await db.deleteOne("things", "a"))).toBeUndefined();
      expect(expectOk(await db.count("things", {}))).toBe(2);
    });

    it("deleteMany returns the number of removed documents", async () => {
      expectOk(await seed());
      expect(expectOk(await db.deleteMany("things", { done: false }))).toBe(2);
      expect(expectOk(await db.findMany<Thing>("things", {})).items.map((d) => d.id)).toEqual(["b"]);
    });

    describe("unique fields", () => {
      beforeEach(async () => {
        expectOk(await db.ensureCollection("users", { email: { type: "string", unique: true }, name: "string" }));
      });

      it("rejects a second document with the same value on create and update, with the field in details", async () => {
        expectOk(await db.createOne("users", { id: "a", email: "a@x", name: "A" }));
        expectOk(await db.createOne("users", { id: "b", email: "b@x", name: "B" }));
        const conflict = expectErr(await db.createOne("users", { id: "c", email: "a@x", name: "C" }), "CONFLICT");
        expect(conflict.status).toBe(409);
        expect(conflict.details).toEqual({ collection: "users", field: "email" });
        expect(expectOk(await db.count("users", {}))).toBe(2);
        expectErr(await db.createMany("users", [{ id: "d", email: "d@x", name: "D" }, { id: "e", email: "b@x", name: "E" }]), "CONFLICT");
        expect(expectOk(await db.count("users", {}))).toBe(2);
        expect(expectErr(await db.updateOne("users", "b", { email: "a@x" }), "CONFLICT").details).toEqual({ collection: "users", field: "email" });
        expect(expectOk(await db.updateOne("users", "a", { email: "a@x", name: "A2" }))).toEqual({ id: "a", email: "a@x", name: "A2" });
        expectErr(await db.updateMany("users", { name: "B" }, { email: "a@x" }), "CONFLICT");
        expect(expectOk(await db.findOne("users", { id: "b" }))).toMatchObject({ email: "b@x" });
      });

      it("allows null more than once and the same value in different collections", async () => {
        expectOk(await db.createOne("users", { id: "a", email: null, name: "A" }));
        expectOk(await db.createOne("users", { id: "b", name: "B" }));
        expectOk(await db.ensureCollection("aliases", { email: { type: "string", unique: true } }));
        expectOk(await db.createOne("users", { id: "c", email: "c@x", name: "C" }));
        expectOk(await db.createOne("aliases", { id: "c", email: "c@x" }));
        expect(expectOk(await db.count("users", { email: null }))).toBe(2);
      });

      it("lets exactly one of two concurrent creates through", async () => {
        const results = await Promise.all([db.createOne("users", { email: "race@x", name: "1" }), db.createOne("users", { email: "race@x", name: "2" })]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok && r.error.code === "CONFLICT")).toHaveLength(1);
      });

      it("is idempotent and can be declared later, unless stored rows already collide", async () => {
        expectOk(await db.ensureCollection("users", { email: { type: "string", unique: true }, name: "string" }));
        expectOk(await db.ensureCollection("tags", { name: "string" }));
        expectOk(await db.createOne("tags", { id: "1", name: "x" }));
        expectOk(await db.createOne("tags", { id: "2", name: "x" }));
        await expect(db.ensureCollection("tags", { name: { type: "string", unique: true } })).rejects.toThrow(/"tags\.name" unique.*"x".*2 times/);
        expectOk(await db.deleteOne("tags", "2"));
        expectOk(await db.ensureCollection("tags", { name: { type: "string", unique: true } }));
        expectErr(await db.createOne("tags", { id: "3", name: "x" }), "CONFLICT");
      });

      it("stops enforcing once the declaration is withdrawn", async () => {
        expectOk(await db.createOne("users", { id: "a", email: "a@x", name: "A" }));
        expectOk(await db.ensureCollection("users", { email: "string", name: "string" }));
        expectOk(await db.createOne("users", { id: "b", email: "a@x", name: "B" }));
      });
    });

    it("returned documents are copies", async () => {
      expectOk(await seed());
      const doc = expectOk(await db.findOne<Thing>("things", { id: "a" }));
      if (doc) doc.meta.tags.push("mutated");
      expect(expectOk(await db.findOne<Thing>("things", { id: "a" }))?.meta.tags).toEqual(["x"]);
    });
  });
}
