import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { createFakePersistence, matchesFilter } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { ok, type Result } from "@michaelthielemann/kestrel/result";
import module from "./module.ts";
import { checkable, createLinksDefault, findUrls, INDEX, isPrivateHost, type Fetcher, type LinkEntry } from "./impl.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: { kind: "multi", fields: { title: { type: "text", localized: true }, body: { type: "json", localized: true }, order: "number" } },
  },
};

function fakeContent(): Content {
  const docs = new Map<string, Record<string, unknown>>();
  const resolve = (row: Record<string, unknown>, locale: string): ContentDocument => {
    const doc: Record<string, unknown> = { id: row.id, createdAt: 1, updatedAt: 1, title: row[`title__${locale}`] ?? null, body: row[`body__${locale}`] ?? null, order: row.order ?? null };
    return doc as ContentDocument;
  };
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(_type, id, options) {
      const row = id === undefined ? undefined : docs.get(id);
      return ok(row ? resolve(row, options?.locale ?? "de") : null);
    },
    async list(_type, filter = {}, options = {}) {
      const all = [...docs.values()].map((r) => resolve(r, options.locale ?? "de")).filter((d) => matchesFilter(d, filter));
      const offset = options.offset ?? 0;
      return ok({ items: all.slice(offset, options.limit === undefined ? undefined : offset + options.limit), total: all.length });
    },
    async create(_type, data, options) {
      const id = randomUUID();
      const locale = options?.locale ?? "de";
      const row: Record<string, unknown> = { id, order: data.order };
      if (data.title !== undefined) row[`title__${locale}`] = data.title;
      if (data.body !== undefined) row[`body__${locale}`] = data.body;
      docs.set(id, row);
      return ok(resolve(row, locale));
    },
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
}

function fakeFetch(statuses: Record<string, number | "timeout" | "error">): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f: Fetcher = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const s = statuses[url];
    if (s === "timeout") return new Promise<{ status: number }>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    if (s === "error" || s === undefined) throw new Error("ENOTFOUND");
    return { status: s };
  };
  return Object.assign(f, { calls });
}

const config = { timeoutMs: 20, concurrency: 2, recheckAfterSeconds: 3600, userAgent: "test", allowPrivate: false };

async function createDoc(content: Content, type: string, data: Record<string, unknown>): Promise<ContentDocument> {
  return expectOk(await content.create(type, data));
}

describe("links/default", () => {
  it("finds urls in strings and nested json, trimming trailing punctuation", () => {
    expect([...findUrls("see https://a.example/x, and http://b.example/y.")]).toEqual(["https://a.example/x", "http://b.example/y"]);
    expect([...findUrls({ blocks: [{ text: "<a href=\"https://c.example/p?q=1\">x</a>" }, ["https://d.example"]] })]).toEqual(["https://c.example/p?q=1", "https://d.example"]);
    expect([...findUrls(42)]).toEqual([]);
  });

  it("refuses private hosts and non-http schemes", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fd00::1", "api.internal"]) expect(isPrivateHost(h)).toBe(true);
    expect(isPrivateHost("example.org")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(checkable("ftp://x.example/f", false)).toBe("unsupported scheme");
    expect(checkable("http://localhost:4000/", false)).toBe("private address");
    expect(checkable("http://localhost:4000/", true)).toBeNull();
    expect(checkable("not a url", false)).toBe("invalid url");
  });

  it("extracts per field and locale, replacing on re-extract", async () => {
    const db = createFakePersistence();
    const content = fakeContent();
    const links = await createLinksDefault(config, content, db, fakeFetch({}));
    const doc = await createDoc(content, "pages", { title: "https://a.example", body: { t: "https://a.example https://b.example" } });
    await createDoc(content, "pages", { title: "x" });
    expect(expectOk(await links.extract("pages", doc.id))).toBe(3);
    const rows = expectOk(await db.findMany<LinkEntry>(INDEX, { fromId: doc.id }, { sort: { field: "asc", url: "asc" } })).items;
    expect(rows.map((r) => `${r.field}:${r.locale}:${r.url}`)).toEqual(["body:de:https://a.example", "body:de:https://b.example", "title:de:https://a.example"]);
    expect(expectOk(await links.extract("pages", doc.id))).toBe(3);
    expect(expectOk(await db.count(INDEX, {}))).toBe(3);
    expect(expectOk(await links.unextract("pages", doc.id))).toBe(3);
    await expect(links.extract("nope", "x")).rejects.toThrow(/unknown type/);
  });

  it("checks each url once, falls back to GET on 405, records timeouts and skips private hosts", async () => {
    const db = createFakePersistence();
    const content = fakeContent();
    const fetcher = fakeFetch({ "https://ok.example": 200, "https://gone.example": 404, "https://headless.example": 405, "https://slow.example": "timeout", "https://down.example": "error" });
    let t = 1_000_000;
    const links = await createLinksDefault(config, content, db, fetcher, () => t);
    const a = await createDoc(content, "pages", { body: ["https://ok.example", "https://gone.example", "https://headless.example", "https://slow.example", "https://down.example", "http://10.0.0.1/admin"] });
    const b = await createDoc(content, "pages", { title: "https://ok.example" });
    expectOk(await links.extract("pages", a.id));
    expectOk(await links.extract("pages", b.id));
    const result = expectOk(await links.check());
    expect(result).toEqual({ urls: 6, checked: 5, broken: 5, skipped: 1 });
    expect(fetcher.calls.filter((c) => c.includes("ok.example"))).toEqual(["HEAD https://ok.example"]);
    expect(fetcher.calls.filter((c) => c.includes("headless"))).toEqual(["HEAD https://headless.example", "GET https://headless.example"]);
    const byUrl = Object.fromEntries(expectOk(await db.findMany<LinkEntry>(INDEX, {}, { limit: 100 })).items.map((r) => [r.url, r]));
    expect(byUrl["https://ok.example"]).toMatchObject({ ok: true, status: 200, checkedAt: t });
    expect(byUrl["https://gone.example"]).toMatchObject({ ok: false, status: 404 });
    expect(byUrl["https://slow.example"]).toMatchObject({ ok: false, status: null, error: "timeout after 20ms" });
    expect(byUrl["https://down.example"]).toMatchObject({ ok: false, error: "ENOTFOUND" });
    expect(byUrl["http://10.0.0.1/admin"]).toMatchObject({ ok: false, error: "private address" });
    expect(expectOk(await links.report()).map((r) => r.url).sort()).toEqual(["http://10.0.0.1/admin", "https://down.example", "https://gone.example", "https://headless.example", "https://slow.example"]);
    expect(expectOk(await links.report("pages")).length).toBe(5);

    fetcher.calls.length = 0;
    expect(expectOk(await links.check()).urls).toBe(0);
    t += 3601 * 1000;
    expect(expectOk(await links.check()).urls).toBe(6);
  });

  it("rebuild reindexes all documents of types with text fields", async () => {
    const db = createFakePersistence();
    const content = fakeContent();
    const links = await createLinksDefault(config, content, db, fakeFetch({}));
    for (let i = 0; i < 120; i++) await createDoc(content, "pages", { title: `https://site${i}.example` });
    await db.createOne(INDEX, { url: "https://stale.example", fromType: "pages", fromId: "stale", field: "title", locale: "de", ok: null, status: null, error: null, checkedAt: null });
    expect(expectOk(await links.rebuild())).toEqual({ documents: 120, entries: 120 });
    expect(expectOk(await db.count(INDEX, { fromId: "stale" }))).toBe(0);
  });

  it("extract and unextract steps map their contract failures through ctx.fail", async () => {
    const db = createFakePersistence();
    const content = fakeContent();
    const links = await createLinksDefault(config, content, db, fakeFetch({}));
    const doc = await createDoc(content, "pages", { title: "https://a.example" });
    const steps = module.steps!(links);
    expect(expectErr(await steps.unextract("pages")(ctx({}, {})), "VALIDATION").message).toBe("missing id");
    expectOk(await steps.extract("pages")(ctxWithResult({ id: doc.id })));
    await expect(steps.extract("pages")(ctxWithResult(undefined))).rejects.toThrow(/no document id in result/);
  });

  it("every contract-backed step answers a retryable 503", async () => {
    const db = createFakePersistence();
    const content = fakeContent();
    const links = await createLinksDefault(config, content, db, fakeFetch({}));
    const doc = await createDoc(content, "pages", { title: "https://a.example" });
    expectOk(await links.extract("pages", doc.id));
    const steps = module.steps!(links);
    const calls: Array<() => Promise<Result<Context, KestrelError>>> = [
      () => steps.extract("pages")(ctxWithResult({ id: doc.id })),
      () => steps.unextract("pages")(ctx({ id: doc.id }, {})),
      () => steps.check(ctx({}, {})),
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

function ctxWithResult(result: unknown): Context {
  return { ...createContext({ trigger: { kind: "http", name: "t" } }), result };
}
