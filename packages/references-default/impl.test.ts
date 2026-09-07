import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { ok, type Result } from "@michaelthielemann/kestrel/result";
import module from "./module.ts";
import { createReferencesDefault, INDEX, referrersLive, type IndexEntry } from "./impl.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { title: "text", hero: { type: "ref", to: "media" }, parent: { type: "ref", to: "pages", localized: true }, body: { type: "json", localized: true } } },
    notes: { kind: "multi", fields: { text: "text" } },
  },
};

const LOCALIZED = ["parent", "body"];

function fakeContent(): Content & { docs: Map<string, Record<string, unknown>> } {
  const docs = new Map<string, Record<string, unknown>>();
  const resolve = (row: Record<string, unknown>, locale: string): ContentDocument => {
    const doc: Record<string, unknown> = { ...row };
    for (const field of LOCALIZED) doc[field] = row[`${field}__${locale}`] ?? null;
    return doc as ContentDocument;
  };
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return {
    docs,
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(type, id, options) {
      const row = id === undefined ? undefined : docs.get(id);
      return ok(row && row.type === type ? resolve(row, options?.locale ?? "de") : null);
    },
    async list(type, filter = {}, options = {}) {
      const locale = options.locale ?? "de";
      const all = [...docs.values()].filter((r) => r.type === type).map((r) => resolve(r, locale)).filter((d) => matchesFilter(d, filter));
      const offset = options.offset ?? 0;
      return ok({ items: all.slice(offset, options.limit === undefined ? undefined : offset + options.limit), total: all.length });
    },
    async create(type, data, options) {
      const id = typeof data.id === "string" ? data.id : randomUUID();
      const locale = options?.locale ?? "de";
      const row: Record<string, unknown> = { id, type, createdAt: 1, updatedAt: 1 };
      for (const [field, value] of Object.entries(data)) row[LOCALIZED.includes(field) ? `${field}__${locale}` : field] = value;
      docs.set(id, row);
      return ok(resolve(row, locale));
    },
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
}

async function setup() {
  const db = createFakePersistence();
  await db.ensureCollection("media_items", { filename: "string" });
  await db.createOne("media_items", { id: "m1", filename: "a.png" });
  const content = fakeContent();
  const refs = createReferencesDefault({ targets: { media: { collection: "media_items" }, pages: { content: "pages" } } }, content, db, () => 42);
  return { db, content, refs };
}

async function createDoc(content: Content, type: string, data: Record<string, unknown>, options?: { locale?: string }): Promise<ContentDocument> {
  return expectOk(await content.create(type, data, options));
}

describe("references/default", () => {
  it("rejects ref fields pointing to unconfigured targets", () => {
    expect(() => createReferencesDefault({ targets: { pages: { content: "pages" } } }, fakeContent(), createFakePersistence())).toThrow(/not a configured target/);
  });

  it("reports missing targets on write", async () => {
    const { refs } = await setup();
    expect(expectOk(await refs.missing("pages", { title: "x", hero: "m1" }))).toEqual([]);
    expect(expectOk(await refs.missing("pages", { title: "x", hero: "nope" }))).toEqual([{ field: "hero", to: "media", id: "nope" }]);
    await expect(refs.missing("nope", {})).rejects.toThrow(/unknown type/);
  });

  it("indexes one entry per ref field and locale, replacing on re-index", async () => {
    const { refs, content, db } = await setup();
    const parent = await createDoc(content, "pages", { title: "root" });
    const child = await createDoc(content, "pages", { title: "child", hero: "m1", parent: parent.id }, { locale: "en" });
    expect(expectOk(await refs.index("pages", child.id))).toBe(2);
    const rows = expectOk(await db.findMany<IndexEntry>(INDEX, { fromId: child.id }, { sort: { field: "asc", locale: "asc" } })).items;
    expect(rows.map((r) => `${r.field}:${r.locale}->${r.toTarget}/${r.toId}`)).toEqual([`hero:->media/m1`, `parent:en->pages/${parent.id}`]);
    expect(expectOk(await refs.index("pages", child.id))).toBe(2);
    expect(expectOk(await db.count(INDEX, { fromId: child.id }))).toBe(2);
    expect(expectOk(await refs.unindex("pages", child.id))).toBe(2);
    expect(expectOk(await refs.index("notes", "whatever"))).toBe(0);
  });

  it("ignores a document referencing itself", async () => {
    const { refs, content } = await setup();
    const page = await createDoc(content, "pages", { id: "loop", title: "loop", parent: "loop" });
    const other = await createDoc(content, "pages", { title: "other", parent: page.id });
    for (const id of [page.id, other.id]) expectOk(await refs.index("pages", id));
    expect(expectOk(await refs.referrers("pages", page.id)).map((r) => r.id)).toEqual([other.id]);
  });

  it("guard via index matches the live scan", async () => {
    const { refs, content } = await setup();
    const parent = await createDoc(content, "pages", { title: "root" });
    const a = await createDoc(content, "pages", { title: "a", hero: "m1", parent: parent.id }, { locale: "en" });
    const b = await createDoc(content, "pages", { title: "b", hero: "m1" });
    for (const id of [parent.id, a.id, b.id]) expectOk(await refs.index("pages", id));
    const cases: Array<[string, string]> = [["media", "m1"], ["pages", parent.id], ["media", "unused"]];
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    for (const [target, id] of cases) {
      expect(expectOk(await refs.referrers(target, id)).sort(byId)).toEqual(expectOk(await referrersLive(content, target, id)).sort(byId));
    }
    expect(expectOk(await refs.referrers("media", "m1")).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    await expect(refs.referrers("nope", "x")).rejects.toThrow(/unknown target/);
  });

  it("scan marks broken references and report lists them", async () => {
    const { refs, content, db } = await setup();
    const page = await createDoc(content, "pages", { title: "a", hero: "m1" });
    expectOk(await refs.index("pages", page.id));
    expect(expectOk(await refs.scan())).toEqual({ checked: 1, broken: 0 });
    await db.deleteOne("media_items", "m1");
    expect(expectOk(await refs.scan())).toEqual({ checked: 1, broken: 1 });
    const report = expectOk(await refs.report());
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ fromType: "pages", fromId: page.id, field: "hero", toTarget: "media", toId: "m1", broken: true, checkedAt: 42 });
    expect(expectOk(await refs.report("pages"))).toEqual([]);
  });

  it("rebuild reindexes every document of types with ref fields", async () => {
    const { refs, content, db } = await setup();
    for (let i = 0; i < 120; i++) await createDoc(content, "pages", { title: `p${i}`, hero: "m1" });
    await createDoc(content, "notes", { text: "no refs" });
    await db.createOne(INDEX, { fromType: "pages", fromId: "stale", field: "hero", locale: "", toTarget: "media", toId: "m1", broken: false, checkedAt: null });
    expect(expectOk(await refs.rebuild())).toEqual({ documents: 120, entries: 120 });
    expect(expectOk(await db.count(INDEX, { fromId: "stale" }))).toBe(0);
    expect(expectOk(await refs.referrers("media", "m1")).length).toBe(120);
  });

  it("referrersMany maps each id to its referrers in the given order, dedupes and rejects bad input", async () => {
    const { refs, content } = await setup();
    const parent = await createDoc(content, "pages", { title: "root" });
    const a = await createDoc(content, "pages", { title: "a", hero: "m1", parent: parent.id }, { locale: "en" });
    const b = await createDoc(content, "pages", { title: "b", hero: "m1" });
    for (const id of [parent.id, a.id, b.id]) expectOk(await refs.index("pages", id));
    const referrersMany = module.steps!(refs).referrersMany;
    const okResult = expectOk(await referrersMany("media")(ctx({}, { ids: ` m1 , unused ,m1` })));
    const result = okResult.result;
    expect(Object.keys(result)).toEqual(["m1", "unused"]);
    expect(result.m1?.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(result.unused).toEqual([]);
    expect(expectErr(await referrersMany("media")(ctx({}, {})), "VALIDATION").message).toBe("references: missing ids");
    expect(expectErr(await referrersMany("media")(ctx({}, { ids: "" })), "VALIDATION").message).toBe("references: missing ids");
    const manyIds = Array.from({ length: 201 }, (_, i) => `id${i}`).join(",");
    expect(expectErr(await referrersMany("media")(ctx({}, { ids: manyIds })), "VALIDATION").message).toBe("references: at most 200 ids");
  });

  it("guardAll passes when result.ids are unreferenced, fails CONFLICT naming the referenced ones", async () => {
    const { refs, content } = await setup();
    const page = await createDoc(content, "pages", { title: "a", hero: "m1" });
    expectOk(await refs.index("pages", page.id));
    const guardAll = module.steps!(refs).guardAll;
    const okResult = expectOk(await guardAll("media")(ctxWithResult({ ids: ["unused"] })));
    expect(okResult.result).toEqual({ ids: ["unused"] });
    const error = expectErr(await guardAll("media")(ctxWithResult({ ids: ["m1", "unused"] })), "CONFLICT");
    expect(error.message).toBe("1 media item(s) are still referenced: media/m1");
    expect(error.status).toBe(409);
  });

  it("index and guardAll throw when the required id is missing at runtime (bug path)", async () => {
    const { refs } = await setup();
    const index = module.steps!(refs).index;
    await expect(index("pages")(ctxWithResult(undefined))).rejects.toThrow(/no document id in result/);
    const guardAll = module.steps!(refs).guardAll;
    await expect(guardAll("media")(ctxWithResult(undefined))).rejects.toThrow(/no ids in result/);
  });

  it("indexes internal links inside json fields as via: body and ignores unconfigured targets", async () => {
    const { refs, content, db } = await setup();
    const other = await createDoc(content, "pages", { title: "other" });
    const page = await createDoc(content, "pages", {
      title: "with blocks",
      body: { blocks: [{ image: "kestrel:media:m1" }, { link: { type: "internal", collection: "pages", id: other.id } }, { note: "kestrel:unknown:x" }, { again: "kestrel:media:m1" }] },
    });
    expect(expectOk(await refs.index("pages", page.id))).toBe(2);
    const rows = expectOk(await db.findMany<IndexEntry>(INDEX, { fromId: page.id }, { sort: { toTarget: "asc" } })).items;
    expect(rows.map((r) => `${r.field}:${r.locale}->${r.toTarget}/${r.toId} (${r.via})`)).toEqual([`body:de->media/m1 (body)`, `body:de->pages/${other.id} (body)`]);

    const guard = module.steps!(refs).guard;
    const guardError = expectErr(await guard("media")(ctxWithParams({ id: "m1" })), "CONFLICT");
    expect(guardError.message).toMatch(/^media\/m1 is referenced by pages\//);
    expect(expectOk(await refs.referrers("pages", other.id))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);

    expect(expectOk(await refs.unindex("pages", page.id))).toBe(2);
    expect(expectOk(await refs.referrers("media", "m1"))).toEqual([]);
    expect(expectOk(await refs.rebuild())).toEqual({ documents: 2, entries: 2 });
    expect(expectOk(await refs.referrers("media", "m1"))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);

    await db.deleteOne("media_items", "m1");
    expect(expectOk(await refs.scan())).toEqual({ checked: 2, broken: 1 });
    expect(expectOk(await refs.report("media"))).toMatchObject([{ fromId: page.id, field: "body", toTarget: "media", toId: "m1", via: "body", broken: true }]);
  });

  it("keeps ref-field rows on via: field and reads rows written before via existed as field", async () => {
    const { refs, content, db } = await setup();
    const page = await createDoc(content, "pages", { title: "a", hero: "m1" });
    expectOk(await refs.index("pages", page.id));
    expect(expectOk(await db.findMany<IndexEntry>(INDEX, { fromId: page.id })).items[0]?.via).toBe("field");
    await db.createOne(INDEX, { fromType: "pages", fromId: "legacy", field: "hero", locale: "", toTarget: "media", toId: "m1", broken: true, checkedAt: 1 });
    expect(expectOk(await refs.referrers("media", "m1"))).toEqual([
      { type: "pages", field: "hero", id: page.id, via: "field" },
      { type: "pages", field: "hero", id: "legacy", via: "field" },
    ]);
    expect(expectOk(await refs.report()).map((r) => r.via)).toEqual(["field"]);
  });

  it("every contract-backed step answers a retryable 503", async () => {
    const { refs, content, db } = await setup();
    const page = await createDoc(content, "pages", { title: "a", hero: "m1" });
    expectOk(await refs.index("pages", page.id));
    const steps = module.steps!(refs);
    const calls: Array<() => Promise<Result<Context, KestrelError>>> = [
      () => steps.check("pages")(ctx({}, { title: "a", hero: "m1" })),
      () => steps.index("pages")(ctxWithResult({ id: page.id })),
      () => steps.unindex("pages")(ctx({ id: page.id }, {})),
      () => steps.guard("media")(ctx({ id: "m1" }, {})),
      () => steps.referrers("media")(ctx({ id: "m1" }, {})),
      () => steps.referrersMany("media")(ctx({}, { ids: "m1" })),
      () => steps.guardAll("media")(ctxWithResult({ ids: ["m1"] })),
      () => steps.scan(ctx({}, {})),
      () => steps.report(ctx({}, {})),
      () => steps.rebuild(ctx({}, {})),
    ];
    for (const call of calls) {
      db.failNext("TRANSIENT");
      const error = expectErr(await call(), "TRANSIENT");
      expect(error.status).toBe(503);
      expect(error.retryable).toBe(true);
    }
  });
});

function ctx(params: Record<string, string>, payload: Record<string, unknown>): Context {
  return createContext({ trigger: { kind: "http", name: "t" }, params, payload });
}

function ctxWithParams(params: Record<string, string>): Context {
  return createContext({ trigger: { kind: "http", name: "t" }, params });
}

function ctxWithResult(result: unknown): Context {
  return { ...createContext({ trigger: { kind: "http", name: "t" } }), result };
}
