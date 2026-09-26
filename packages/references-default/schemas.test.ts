import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { MEDIA } from "@michaelthielemann/kestrel-contracts/media";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakeMedia } from "@michaelthielemann/kestrel-contracts/testing/fakeMedia";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import module, { configSchema } from "./module.ts";
import { createReferencesDefault, INDEX, type IndexEntry, type References } from "./impl.ts";
import { collectSchemaRefs } from "./schema-refs.ts";

const model: ContentModel = {
  types: {
    pages: { kind: "multi", fields: { title: "text", body: "json", meta: "json" } },
    notes: { kind: "multi", fields: { text: "text" } },
  },
};

const mediaId = { type: "string", "x-kestrel-ref": "media" };
const pageId = { type: "string", "x-kestrel-ref": "pages" };
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: "null" }] });
const node = (name: string, props: Record<string, unknown>, slots: string[] = []) => ({
  type: "object",
  properties: {
    id: { type: "string" },
    type: { const: name },
    props: { type: "object", properties: props, additionalProperties: false },
    slots: { type: "object", properties: Object.fromEntries(slots.map((slot) => [slot, { type: "array", items: { $ref: "#/$defs/node" } }])), additionalProperties: false },
  },
  required: ["type"],
});

const bodySchema: Record<string, unknown> = {
  type: "array",
  items: { $ref: "#/$defs/node" },
  $defs: {
    node: { oneOf: ["hero", "gallery", "section", "teaser"].map((name) => ({ $ref: `#/$defs/${name}` })) },
    hero: node("hero", { image: nullable(mediaId), caption: nullable({ type: "string" }) }),
    gallery: node("gallery", {
      images: nullable({ type: "array", items: mediaId }),
      slides: nullable({ type: "array", items: { type: "object", properties: { picture: nullable(mediaId), label: { type: "string" } } } }),
    }),
    section: node("section", { heading: { type: "string" } }, ["children"]),
    teaser: node("teaser", { target: nullable(pageId), related: nullable({ type: "array", items: pageId }), tag: { type: "string", "x-kestrel-ref": "tags" } }),
  },
};

function fakeContent(): Content & { docs: Map<string, Record<string, unknown>> } {
  const docs = new Map<string, Record<string, unknown>>();
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return {
    docs,
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(type, id) {
      const row = id === undefined ? undefined : docs.get(id);
      return ok(row && row.type === type ? boundaryCast<ContentDocument>(row, "host") : null);
    },
    async list(type, _filter, options = {}) {
      const all = boundaryCast<ContentDocument[]>([...docs.values()].filter((r) => r.type === type), "host");
      const offset = options.offset ?? 0;
      return ok({ items: all.slice(offset, options.limit === undefined ? undefined : offset + options.limit), total: all.length });
    },
    async create(type, data) {
      const id = typeof data.id === "string" ? data.id : randomUUID();
      const row = { ...data, id, type, createdAt: 1, updatedAt: 1 };
      docs.set(id, row);
      return ok(boundaryCast<ContentDocument>(row, "host"));
    },
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
}

function setup(schemas: Record<string, string | Record<string, unknown>> = { "pages.body": bodySchema }) {
  const db = createFakePersistence();
  const content = fakeContent();
  const refs = createReferencesDefault({ targets: { media: { collection: "asset_rows" }, pages: { content: "pages" } }, schemas }, content, db, () => 42);
  return { db, content, refs };
}

async function create(content: Content, data: Record<string, unknown>): Promise<ContentDocument> {
  return expectOk(await content.create("pages", data));
}

async function indexed(db: ReturnType<typeof createFakePersistence>, fromId: string): Promise<string[]> {
  const rows = expectOk(await db.findMany<IndexEntry>(INDEX, { fromId })).items;
  return rows.map((r) => `${r.field}->${r.toTarget}/${r.toId} (${r.via})`).sort();
}

describe("collectSchemaRefs", () => {
  it("finds ids only at positions the schema marks, through $ref, oneOf by type and anyOf by kind", () => {
    const body = [
      { type: "hero", props: { image: "m1", caption: "m9" } },
      { type: "gallery", props: { images: ["m2", "m3"], slides: [{ picture: "m4", label: "m9" }, { picture: null }] } },
      { type: "section", slots: { children: [{ type: "section", slots: { children: [{ type: "hero", props: { image: "m5" } }] } }] } },
      { type: "unknown", props: { image: "m9" } },
      { type: "teaser", props: { target: "p1", related: ["p2"] } },
    ];
    expect(collectSchemaRefs(bodySchema, body)).toEqual([
      { target: "media", id: "m1" },
      { target: "media", id: "m2" },
      { target: "media", id: "m3" },
      { target: "media", id: "m4" },
      { target: "media", id: "m5" },
      { target: "pages", id: "p1" },
      { target: "pages", id: "p2" },
    ]);
  });

  it("ignores empty strings, non-string values and values that do not match the schema's shape", () => {
    expect(collectSchemaRefs(bodySchema, [{ type: "hero", props: { image: "" } }, { type: "gallery", props: { images: [3, null, "m1"] } }, "loose", null])).toEqual([{ target: "media", id: "m1" }]);
    expect(collectSchemaRefs(bodySchema, { type: "hero", props: { image: "m1" } })).toEqual([]);
    expect(collectSchemaRefs(bodySchema, undefined)).toEqual([]);
  });

  it("dedupes repeated ids", () => {
    expect(collectSchemaRefs(bodySchema, [{ type: "hero", props: { image: "m1" } }, { type: "gallery", props: { images: ["m1"] } }])).toEqual([{ target: "media", id: "m1" }]);
  });
});

describe("references/default: ids inside json fields described by a schema", () => {
  it("indexes a media id in a single block field and guards its deletion", async () => {
    const { db, content, refs } = setup();
    const page = await create(content, { title: "a", body: [{ type: "hero", props: { image: "m1", caption: "not an id" } }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(1);
    expect(await indexed(db, page.id)).toEqual(["body->media/m1 (body)"]);
    expect(expectOk(await refs.referrers("media", "m1"))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);
    const error = expectErr(await module.steps!(refs).guard("media")(createContext({ trigger: { kind: "http", name: "t" }, params: { id: "m1" } })), "CONFLICT");
    expect(error.status).toBe(409);
    expect(error.message).toBe(`media/m1 is referenced by pages/${page.id} (body)`);
  });

  it("indexes every id of a multiple media field and of a repeater", async () => {
    const { db, content, refs } = setup();
    const page = await create(content, { title: "a", body: [{ type: "gallery", props: { images: ["m1", "m2"], slides: [{ picture: "m3" }] } }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(3);
    expect(await indexed(db, page.id)).toEqual(["body->media/m1 (body)", "body->media/m2 (body)", "body->media/m3 (body)"]);
  });

  it("indexes ids of blocks nested in slots", async () => {
    const { db, content, refs } = setup();
    const page = await create(content, { title: "a", body: [{ type: "section", slots: { children: [{ type: "section", slots: { children: [{ type: "hero", props: { image: "deep" } }] } }] } }] });
    expectOk(await refs.index("pages", page.id));
    expect(await indexed(db, page.id)).toEqual(["body->media/deep (body)"]);
  });

  it("indexes page relations inside blocks, so the page delete guard sees them", async () => {
    const { content, refs } = setup();
    const target = await create(content, { title: "target" });
    const other = await create(content, { title: "other" });
    const page = await create(content, { title: "a", body: [{ type: "teaser", props: { target: target.id, related: [other.id], tag: "t1" } }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(2);
    expect(expectOk(await refs.referrers("pages", target.id))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);
    expect(expectOk(await refs.referrers("pages", other.id))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);
  });

  it("counts an id once when an internal link and a marked position name the same file", async () => {
    const { db, content, refs } = setup();
    const page = await create(content, { title: "a", body: [{ type: "hero", props: { image: "m1", caption: "kestrel:media:m1" } }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(1);
    expect(await indexed(db, page.id)).toEqual(["body->media/m1 (body)"]);
  });

  it("leaves json fields without a schema to internal links only", async () => {
    const { db, content, refs } = setup();
    const page = await create(content, { title: "a", meta: [{ type: "hero", props: { image: "m1" } }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(0);
    expect(await indexed(db, page.id)).toEqual([]);
  });

  it("rebuild picks up block references of documents written before the schema was configured", async () => {
    const { db, content } = setup();
    const page = await create(content, { title: "a", body: [{ type: "gallery", props: { images: ["m1"] } }] });
    const before = createReferencesDefault({ targets: { media: { collection: "asset_rows" }, pages: { content: "pages" } } }, content, db);
    expect(expectOk(await before.rebuild())).toEqual({ documents: 1, entries: 0 });
    const after = createReferencesDefault({ targets: { media: { collection: "asset_rows" }, pages: { content: "pages" } }, schemas: { "pages.body": bodySchema } }, content, db);
    expect(expectOk(await after.rebuild())).toEqual({ documents: 1, entries: 1 });
    expect(expectOk(await after.referrers("media", "m1"))).toEqual([{ type: "pages", field: "body", id: page.id, via: "body" }]);
  });

  it("rejects a schema for anything but a json field of the model", () => {
    expect(() => setup({ "pages.title": bodySchema })).toThrow('references/default: schema "pages.title" must name a json field of the content model');
    expect(() => setup({ "nope.body": bodySchema })).toThrow('references/default: schema "nope.body" must name a json field of the content model');
    expect(() => setup({ pages: bodySchema })).toThrow('references/default: schema "pages" must name a json field of the content model');
  });
});

describe("references/default module: schema files", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function deps(root: string) {
    const content = fakeContent();
    const media = createFakeMedia();
    const providers = new Map<string, unknown>([[CONTENT.name, content], [PERSISTENCE.name, createFakePersistence()], [MEDIA.name, media]]);
    const value: Deps = {
      get: <T>(contract: Contract<T>): T => boundaryCast<T>(providers.get(contract.name), "host"),
      find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
      logger: silentLogger,
      root,
      eventTriggers: [],
    };
    return { value, content };
  }

  function tempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "references-schemas-"));
    dirs.push(dir);
    return dir;
  }

  it("accepts a schema path or an inline schema per field", () => {
    expect(configSchema.safeParse({ targets: {}, schemas: { "pages.body": "schemas/body.json", "pages.meta": { type: "array" } } }).success).toBe(true);
    expect(configSchema.safeParse({ targets: {}, schemas: { "pages.body": "" } }).success).toBe(false);
  });

  it("reads a schema file relative to the root and follows changes to it", async () => {
    const root = tempRoot();
    const file = join(root, "body.json");
    writeFileSync(file, JSON.stringify({ type: "array", items: { type: "object", properties: { image: mediaId } } }));
    const { value, content } = deps(root);
    const refs = boundaryCast<References>(await module.setup(configSchema.parse({ targets: { media: { media: true }, pages: { content: "pages" } }, schemas: { "pages.body": "body.json" } }), value), "host");
    const page = await create(content, { title: "a", body: [{ image: "m1", picture: "m2" }] });
    expect(expectOk(await refs.index("pages", page.id))).toBe(1);

    const changed = boundaryCast<{ items: { properties: Record<string, unknown> } }>(JSON.parse(readFileSync(file, "utf8")), "json");
    changed.items.properties.picture = mediaId;
    writeFileSync(file, JSON.stringify(changed));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(expectOk(await refs.index("pages", page.id))).toBe(2);
  });

  it("fails setup when a schema file cannot be read, naming the field and the path", async () => {
    const root = tempRoot();
    const { value } = deps(root);
    await expect(module.setup(configSchema.parse({ targets: { pages: { content: "pages" } }, schemas: { "pages.body": "missing.json" } }), value)).rejects.toThrow(`references/default: cannot read schema for "pages.body" at ${join(root, "missing.json")}`);
  });
});
