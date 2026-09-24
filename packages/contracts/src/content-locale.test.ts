import { describe, it, expect } from "vitest";
import type { Content, ContentDocument, ContentModel } from "./content.ts";
import { ok } from "./errors.ts";
import { defaultLocaleSatisfiesFilter, nonLocalizedFilter, publishedLocale, satisfiesFilter } from "./content-locale.ts";

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

function fakeContent(docs: Record<string, FakeDoc>): Content {
  return {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(_type, id, options) {
      if (id === undefined) return ok(null);
      const entry = docs[id];
      if (!entry) return ok(null);
      const locale = options?.locale ?? "de";
      const own = entry.locales[locale];
      const base = options?.fallback === true ? { ...entry.locales.de, ...own } : own;
      if (!base) return ok(null);
      const doc: ContentDocument = { id, createdAt: 1, updatedAt: 1, ...base, ...(entry.translations ? { _translations: entry.translations } : {}) };
      return ok(doc);
    },
    async list() {
      throw new Error("not used");
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
});

describe("nonLocalizedFilter", () => {
  it("keeps only the entries that are not declared localized on the type", () => {
    expect(nonLocalizedFilter(model, "pages", { status: "published", archived: false })).toEqual({ archived: false });
  });
});

describe("publishedLocale", () => {
  it("returns null when the requested locale itself does not satisfy the filter", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "draft", body: "EN" } } } });
    const result = await publishedLocale(content, model, "pages", "p1", "en", { status: "published" }, true);
    expect(result).toEqual({ ok: true, value: null });
  });

  it("fills an empty field from the default locale only when the default locale satisfies the filter", async () => {
    const published = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published" } } } });
    const filled = await publishedLocale(published, model, "pages", "p1", "en", { status: "published" }, true);
    expect(filled.ok && filled.value?.body).toBe("DE");

    const draftDefault = fakeContent({ p1: { locales: { de: { status: "draft", body: "DE" }, en: { status: "published" } } } });
    const empty = await publishedLocale(draftDefault, model, "pages", "p1", "en", { status: "published" }, true);
    expect(empty.ok && (empty.value?.body ?? null)).toBeNull();
  });

  it("never fills a field when fallback is disabled", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" }, en: { status: "published" } } } });
    const result = await publishedLocale(content, model, "pages", "p1", "en", { status: "published" }, false);
    expect(result.ok && (result.value?.body ?? null)).toBeNull();
  });

  it("narrows _translations to locales that themselves satisfy the filter", async () => {
    const content = fakeContent({
      p1: {
        locales: { de: { status: "published", body: "DE" }, en: { status: "draft", body: "EN" } },
        translations: { de: true, en: true },
      },
    });
    const result = await publishedLocale(content, model, "pages", "p1", "de", { status: "published" }, true);
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: false });
  });

  it("leaves an incomplete translation's false entry untouched without fetching that locale", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published", body: "DE" } }, translations: { de: true, en: false } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
    const result = await publishedLocale(spied, model, "pages", "p1", "de", { status: "published" }, true);
    expect(result.ok && result.value?._translations).toEqual({ de: true, en: false });
    expect(calls).not.toContain("en");
  });
});

describe("defaultLocaleSatisfiesFilter", () => {
  it("is true only when the default locale's own strict values satisfy the filter", async () => {
    const published = fakeContent({ p1: { locales: { de: { status: "published" } } } });
    expect(await defaultLocaleSatisfiesFilter(published, "de", "pages", "p1", { status: "published" })).toEqual({ ok: true, value: true });

    const draft = fakeContent({ p1: { locales: { de: { status: "draft" } } } });
    expect(await defaultLocaleSatisfiesFilter(draft, "de", "pages", "p1", { status: "published" })).toEqual({ ok: true, value: false });
  });

  it("is false without a default locale, without fetching anything", async () => {
    const content = fakeContent({ p1: { locales: { de: { status: "published" } } } });
    const calls: Array<string | undefined> = [];
    const spied: Content = { ...content, get: (type, id, options) => (calls.push(options?.locale), content.get(type, id, options)) };
    expect(await defaultLocaleSatisfiesFilter(spied, undefined, "pages", "p1", { status: "published" })).toEqual({ ok: true, value: false });
    expect(calls).toEqual([]);
  });
});
