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
        status: { type: "enum", options: ["draft", "published"], localized: true },
        archived: { type: "boolean" },
      },
    },
  },
};

interface FakeDoc {
  locales: Record<string, Record<string, unknown> | undefined>;
  translations?: Record<string, boolean>;
}

function isInCondition(value: unknown): value is { in: string[] } {
  return typeof value === "object" && value !== null && Array.isArray(Reflect.get(value, "in"));
}

function fakeContent(docs: Record<string, FakeDoc>): Content {
  const valuesAt = (entry: FakeDoc, locale: string, fallback: boolean): Record<string, unknown> | undefined => {
    const own = entry.locales[locale];
    return fallback ? { ...entry.locales.de, ...own } : own;
  };
  return {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(_type, id, options) {
      if (id === undefined) return ok(null);
      const entry = docs[id];
      if (!entry) return ok(null);
      const base = valuesAt(entry, options?.locale ?? "de", options?.fallback === true);
      if (!base) return ok(null);
      const doc: ContentDocument = { id, createdAt: 1, updatedAt: 1, ...base, ...(entry.translations ? { _translations: entry.translations } : {}) };
      return ok(doc);
    },
    async list(_type, filter = {}, options = {}) {
      const locale = options.locale ?? "de";
      const idFilter = filter.id;
      const idIn = isInCondition(idFilter) ? new Set(idFilter.in) : undefined;
      const rest = Object.fromEntries(Object.entries(filter).filter(([f]) => f !== "id"));
      const items: ContentDocument[] = [];
      for (const [id, entry] of Object.entries(docs)) {
        if (idIn && !idIn.has(id)) continue;
        const base = valuesAt(entry, locale, false);
        if (!base) continue;
        if (!Object.entries(rest).every(([f, v]) => base[f] === v)) continue;
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
  it("requires every filter entry to match the given values", () => {
    expect(satisfiesFilter({ status: "published" }, { status: "published" })).toBe(true);
    expect(satisfiesFilter({ status: "published" }, { status: "draft" })).toBe(false);
    expect(satisfiesFilter({ status: "published" }, null)).toBe(false);
    expect(satisfiesFilter({}, null)).toBe(true);
  });

  it("throws on a Condition instead of silently failing every document", () => {
    expect(() => satisfiesFilter({ status: { in: ["published", "featured"] } }, { status: "published" })).toThrow(/Condition/);
    expect(() => satisfiesFilter({ status: { ne: "draft" } }, { status: "published" })).toThrow(/Condition/);
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

  it("skips the _translations narrowing with an empty filter, without fetching another locale", async () => {
    const content = fakeContent({
      p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published", body: "EN" } }, translations: { de: true, en: true } },
    });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
    const result = await publishedLocale(spied, "pages", "p1", "de", {}, { fallback: false });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: true });
    expect(calls).toEqual(["de"]);
  });

  it("leaves an incomplete translation's false entry untouched without fetching that locale", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" } }, translations: { de: true, en: false } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
    const result = await publishedLocale(spied, "pages", "p1", "de", { status: "published" }, { fallback: true });
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: false });
    expect(calls).not.toContain("en");
  });

  it("keys its cache by the effective locale, so an unprefixed request and the default locale share one read", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" } }, translations: { de: true, en: false } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
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
