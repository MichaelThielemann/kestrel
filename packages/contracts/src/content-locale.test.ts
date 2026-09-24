import { describe, it, expect } from "vitest";
import type { Content, ContentDocument, ContentModel } from "./content.ts";
import { ok } from "./errors.ts";
import { narrowListTranslations, publishedLocale, satisfiesFilter } from "./content-locale.ts";

const model: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", localized: true },
        title: { type: "text", localized: true },
        body: { type: "text", localized: true },
        status: { type: "enum", options: ["draft", "published", "featured"], localized: true },
        archived: { type: "boolean" },
      },
    },
  },
};

const model3: ContentModel = {
  locales: ["de", "en", "fr"],
  defaultLocale: "de",
  types: model.types,
};

interface FakeDoc {
  locales: Record<string, Record<string, unknown> | undefined>;
  translations?: Record<string, boolean>;
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
    const inList: unknown = Reflect.get(expected, "in");
    if (Array.isArray(inList)) return inList.includes(actual);
    if ("ne" in expected) return actual !== Reflect.get(expected, "ne");
  }
  return actual === expected;
}

function fakeContent(docs: Record<string, FakeDoc>, forModel: ContentModel = model): Content {
  const valuesAt = (entry: FakeDoc, locale: string, fallback: boolean): Record<string, unknown> | undefined => {
    const own = entry.locales[locale];
    return fallback ? { ...entry.locales[forModel.defaultLocale ?? "de"], ...own } : own;
  };
  return {
    model: () => forModel,
    validate: () => ({ ok: true, data: {} }),
    async get(_type, id, options) {
      if (id === undefined) return ok(null);
      const entry = docs[id];
      if (!entry) return ok(null);
      const base = valuesAt(entry, options?.locale ?? (forModel.defaultLocale ?? "de"), options?.fallback === true);
      if (!base) return ok(null);
      const doc: ContentDocument = { id, createdAt: 1, updatedAt: 1, ...base, ...(entry.translations ? { _translations: entry.translations } : {}) };
      return ok(doc);
    },
    async list(_type, filter = {}, options = {}) {
      const locale = options.locale ?? (forModel.defaultLocale ?? "de");
      const items: ContentDocument[] = [];
      for (const [id, entry] of Object.entries(docs)) {
        const base = valuesAt(entry, locale, false);
        if (!base) continue;
        const record: Record<string, unknown> = { id, ...base };
        if (!Object.entries(filter).every(([f, v]) => matchesValue(record[f], v))) continue;
        items.push({ id, createdAt: 1, updatedAt: 1, ...base, ...(entry.translations ? { _translations: entry.translations } : {}) });
      }
      return ok({ items: items.slice(0, options.limit), total: items.length });
    },
    async create() {
      throw new Error("not used");
    },
    async set() {
      throw new Error("not used");
    },
    async update() {
      throw new Error("not used");
    },
    async remove() {
      throw new Error("not used");
    },
    async removeTranslation() {
      throw new Error("not used");
    },
  };
}

describe("satisfiesFilter", () => {
  it("is true with no filter entries, without a read", async () => {
    const content = fakeContent({});
    const calls: unknown[] = [];
    const spied: Content = { ...content, list: (...args) => (calls.push(args), content.list(...args)) };
    expect(await satisfiesFilter(spied, "pages", "p1", "de", {})).toEqual({ ok: true, value: true });
    expect(calls).toEqual([]);
  });

  it("lets the store decide plain equality", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published" } } } });
    expect(await satisfiesFilter(content, "pages", "p1", "de", { status: "published" })).toEqual({ ok: true, value: true });
    expect(await satisfiesFilter(content, "pages", "p1", "de", { status: "draft" })).toEqual({ ok: true, value: false });
    expect(await satisfiesFilter(content, "pages", "missing", "de", { status: "published" })).toEqual({ ok: true, value: false });
  });

  it("lets the store evaluate an `in` Condition instead of failing every document", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "featured" } } }, p2: { locales: { de: { status: "draft" } } } });
    expect(await satisfiesFilter(content, "pages", "p1", "de", { status: { in: ["published", "featured"] } })).toEqual({ ok: true, value: true });
    expect(await satisfiesFilter(content, "pages", "p2", "de", { status: { in: ["published", "featured"] } })).toEqual({ ok: true, value: false });
  });

  it("lets the store evaluate a `ne` Condition instead of failing every document", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published" } } }, p2: { locales: { de: { status: "draft" } } } });
    expect(await satisfiesFilter(content, "pages", "p1", "de", { status: { ne: "draft" } })).toEqual({ ok: true, value: true });
    expect(await satisfiesFilter(content, "pages", "p2", "de", { status: { ne: "draft" } })).toEqual({ ok: true, value: false });
  });

  it("ignores a meaningless id for a single type instead of filtering the store by it", async () => {
    const single: ContentModel = { locales: ["de"], defaultLocale: "de", types: { settings: { kind: "single", fields: { title: { type: "text" }, status: { type: "enum", options: ["draft", "published"] } } } } };
    const content: Content = {
      model: () => single,
      validate: () => ({ ok: true, data: {} }),
      get: () => Promise.reject(new Error("not used")),
      async list(_type, filter = {}) {
        const row: Record<string, unknown> = { id: "real-id", status: "published" };
        const matches = Object.entries(filter).every(([f, v]) => row[f] === v);
        return ok({ items: matches ? [{ id: "real-id", createdAt: 1, updatedAt: 1, status: "published" }] : [], total: matches ? 1 : 0 });
      },
      create: () => Promise.reject(new Error("not used")),
      set: () => Promise.reject(new Error("not used")),
      update: () => Promise.reject(new Error("not used")),
      remove: () => Promise.reject(new Error("not used")),
      removeTranslation: () => Promise.reject(new Error("not used")),
    };
    const routeWithNoIdParam = "";
    expect(await satisfiesFilter(content, "settings", routeWithNoIdParam, "de", { status: "published" })).toEqual({ ok: true, value: true });
  });
});

describe("publishedLocale", () => {
  it("returns null when the requested locale itself does not satisfy the filter", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "draft", body: "EN" } } } });
    const result = await publishedLocale(content, "pages", "p1", "en", { status: "published" }, { fallback: true });
    expect(result).toEqual({ ok: true, value: null });
  });

  it("fills an empty field from the default locale only when the default locale satisfies the filter", async () => {
    const published = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published" } } } });
    const filled = await publishedLocale(published, "pages", "p1", "en", { status: "published" }, { fallback: true });
    expect(filled.ok && filled.value?.body).toBe("DE");

    const draftDefault = fakeContent({ p1: { locales: { de: { status: "draft", body: "DE" }, en: { status: "published" } } } });
    const empty = await publishedLocale(draftDefault, "pages", "p1", "en", { status: "published" }, { fallback: true });
    expect(empty.ok && (empty.value?.body ?? null)).toBeNull();
  });

  it("resolves a Condition filter the same way a scalar one is resolved, fallback included", async () => {
    const published = fakeContent({ p1: { locales: { de: { status: "featured", body: "DE" }, en: { status: "published" } } } });
    const filled = await publishedLocale(published, "pages", "p1", "en", { status: { in: ["published", "featured"] } }, { fallback: true });
    expect(filled.ok && filled.value?.body).toBe("DE");

    const draftDefault = fakeContent({ p1: { locales: { de: { status: "draft", body: "DE" }, en: { status: "published" } } } });
    const empty = await publishedLocale(draftDefault, "pages", "p1", "en", { status: { in: ["published", "featured"] } }, { fallback: true });
    expect(empty.ok && (empty.value?.body ?? null)).toBeNull();
  });

  it("never fills a field when fallback is disabled", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published" } } } });
    const result = await publishedLocale(content, "pages", "p1", "en", { status: "published" }, { fallback: false });
    expect(result.ok && (result.value?.body ?? null)).toBeNull();
  });

  it("narrows _translations to locales that themselves satisfy the filter", async () => {
    const content = fakeContent({
      p1: {
        locales: { de: { status: "published", body: "DE" }, en: { status: "draft", body: "EN" } },
        translations: { de: true, en: true },
      },
    });
    const result = await publishedLocale(content, "pages", "p1", "de", { status: "published" }, { fallback: true });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: false });
  });

  it("narrows _translations for a locale that is neither the requested nor the default locale", async () => {
    const content = fakeContent(
      { p1: { locales: { de: { status: "published" }, en: { status: "published" }, fr: { status: "draft" } }, translations: { de: true, en: true, fr: true } } },
      model3,
    );
    const result = await publishedLocale(content, "pages", "p1", "en", { status: "published" }, { fallback: false });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: true, fr: false });
  });

  it("skips the _translations narrowing when translations: false", async () => {
    const content = fakeContent({
      p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "draft", body: "EN" } }, translations: { de: true, en: true } },
    });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
    const result = await publishedLocale(spied, "pages", "p1", "de", { status: "published" }, { fallback: true, translations: false });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: true });
    expect(calls).not.toContain("en");
  });

  it("skips the _translations narrowing with an empty filter, without an extra read", async () => {
    const content = fakeContent({
      p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published", body: "EN" } }, translations: { de: true, en: true } },
    });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, list: (...args) => (calls.push(args[2]?.locale), content.list(...args)) };
    const result = await publishedLocale(spied, "pages", "p1", "de", {}, { fallback: false });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: true });
    expect(calls).toEqual([]);
  });

  it("leaves an incomplete translation's false entry untouched without checking that locale", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" } }, translations: { de: true, en: false } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, list: (...args) => (calls.push(args[2]?.locale), content.list(...args)) };
    const result = await publishedLocale(spied, "pages", "p1", "de", { status: "published" }, { fallback: true });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: false });
    expect(calls).not.toContain("en");
  });

  it("does not re-check the effective locale a second time inside the _translations loop", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" } }, translations: { de: true, en: false } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, list: (...args) => (calls.push(args[2]?.locale), content.list(...args)) };
    await publishedLocale(spied, "pages", "p1", undefined, { status: "published" }, { fallback: true });
    expect(calls).toEqual([undefined]);
  });

  it("accepts an id-less read for a single type", async () => {
    const content: Content = {
      model: () => model,
      validate: () => ({ ok: true, data: {} }),
      async get() {
        return ok({ id: "settings", createdAt: 1, updatedAt: 1, title: "Site" });
      },
      list: () => Promise.reject(new Error("not used")),
      create: () => Promise.reject(new Error("not used")),
      set: () => Promise.reject(new Error("not used")),
      update: () => Promise.reject(new Error("not used")),
      remove: () => Promise.reject(new Error("not used")),
      removeTranslation: () => Promise.reject(new Error("not used")),
    };
    const result = await publishedLocale(content, "settings", undefined, undefined, {}, { fallback: false });
    expect(result.ok && result.value?.title).toBe("Site");
  });
});

describe("narrowListTranslations", () => {
  it("is a no-op with an empty filter, no items, or no locales beyond the requested one", async () => {
    const content = fakeContent({});
    expect(await narrowListTranslations(content, "pages", [], { status: "published" }, "de")).toEqual({ ok: true, value: [] });
    const items: ContentDocument[] = [{ id: "p1", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } }];
    expect(await narrowListTranslations(content, "pages", items, {}, "de")).toEqual({ ok: true, value: items });
  });

  it("narrows other locales in one query per locale, leaving the requested locale's own flag untouched", async () => {
    const content = fakeContent({
      p1: { locales: { de: { status: "published" }, en: { status: "draft" } }, translations: { de: true, en: true } },
      p2: { locales: { de: { status: "published" }, en: { status: "published" } }, translations: { de: true, en: true } },
    });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, list: (type, filter, options) => (calls.push(options?.locale), content.list(type, filter, options)) };
    const items = [
      { id: "p1", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } },
      { id: "p2", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } },
    ];
    const result = await narrowListTranslations(spied, "pages", items, { status: "published" }, "de");
    expect(result.ok && result.value.map((d) => [d.id, d._translations])).toEqual([
      ["p1", { de: true, en: false }],
      ["p2", { de: true, en: true }],
    ]);
    expect(calls).toEqual(["en"]);
  });

  it("evaluates a Condition entry through the store, batched, the same as a scalar one", async () => {
    const content = fakeContent({
      p1: { locales: { de: { status: "published" }, en: { status: "draft" } }, translations: { de: true, en: true } },
      p2: { locales: { de: { status: "published" }, en: { status: "featured" } }, translations: { de: true, en: true } },
    });
    const items = [
      { id: "p1", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } },
      { id: "p2", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } },
    ];
    const result = await narrowListTranslations(content, "pages", items, { status: { in: ["published", "featured"] } }, "de");
    expect(result.ok && result.value.map((d) => [d.id, d._translations])).toEqual([
      ["p1", { de: true, en: false }],
      ["p2", { de: true, en: true }],
    ]);
  });

  it("treats an undefined requested locale as the model's default locale, not as its own extra locale", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published" }, en: { status: "draft" } }, translations: { de: true, en: true } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, list: (type, filter, options) => (calls.push(options?.locale), content.list(type, filter, options)) };
    const items = [{ id: "p1", createdAt: 1, updatedAt: 1, _translations: { de: true, en: true } }];
    const result = await narrowListTranslations(spied, "pages", items, { status: "published" }, undefined);
    expect(result.ok && result.value[0]?._translations).toEqual({ de: true, en: false });
    expect(calls).toEqual(["en"]);
  });

  it("keeps a locale's false entry false without including it in the query result", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published" } }, translations: { de: true, en: false } } });
    const items = [{ id: "p1", createdAt: 1, updatedAt: 1, _translations: { de: true, en: false } }];
    const result = await narrowListTranslations(content, "pages", items, { status: "published" }, "de");
    expect(result.ok && result.value[0]?._translations).toEqual({ de: true, en: false });
  });
});
