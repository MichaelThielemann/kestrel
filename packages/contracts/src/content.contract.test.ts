import { describe, it, expect, beforeEach } from "vitest";
import type { Content, ContentError, ContentModel, FieldError } from "./content.ts";
import { expectErr, expectOk } from "./testing/result.ts";

const fieldsOf = (error: ContentError): string[] => ((error.details?.fields ?? []) as FieldError[]).map((f) => f.field).sort();

export const CONTENT_TEST_MODEL: ContentModel = {
  types: {
    settings: { kind: "single", fields: { title: { type: "text", required: true }, navigation: "json" } },
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true },
        title: { type: "text", required: true },
        body: "richtext",
        published: "boolean",
        publishedAt: "date",
        order: "number",
        status: { type: "enum", options: ["draft", "finished", "published"] },
        hero: { type: "ref", to: "media" },
      },
    },
  },
};

export const CONTENT_I18N_MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        body: { type: "json", localized: true },
        status: { type: "enum", options: ["draft", "published"], required: true },
      },
    },
  },
};

export const CONTENT_PUBLISH_MODEL: ContentModel = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], localized: true },
      },
      completeWhen: { field: "status", equals: "published" },
    },
  },
};

export function contentContractTests(make: (model: ContentModel) => Promise<Content>) {
  describe("content@1", () => {
    let content: Content;
    beforeEach(async () => {
      content = await make(CONTENT_TEST_MODEL);
    });

    it("exposes the model", () => {
      expect(Object.keys(content.model().types).sort()).toEqual(["pages", "settings"]);
    });

    it("unknown type throws", async () => {
      await expect(content.get("nope", "1")).rejects.toThrow(/nope/);
      expect(() => content.validate("nope", {}, "create")).toThrow(/nope/);
    });

    describe("validate", () => {
      it("accepts valid data and rejects unknown fields", () => {
        expect(content.validate("pages", { slug: "home", title: "Home" }, "create")).toEqual({ ok: true, data: { slug: "home", title: "Home" } });
        const r = content.validate("pages", { slug: "home", title: "Home", extra: 1 }, "create");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.field)).toEqual(["extra"]);
      });

      it("reports missing required fields on create but not on update", () => {
        const r = content.validate("pages", { title: "x" }, "create");
        expect(r).toEqual({ ok: false, errors: [{ field: "slug", message: "required" }] });
        expect(content.validate("pages", { title: "x" }, "update").ok).toBe(true);
      });

      it("checks field types", () => {
        const r = content.validate("pages", { slug: "Bad Slug", title: 5, published: "yes", order: "1", publishedAt: "not a date", body: {} }, "create");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["body", "order", "published", "publishedAt", "slug", "title"]);
      });

      it("normalises dates to milliseconds", () => {
        const r = content.validate("pages", { slug: "a", title: "a", publishedAt: "2026-01-02T03:04:05.000Z" }, "create");
        expect(r).toMatchObject({ ok: true, data: { publishedAt: Date.parse("2026-01-02T03:04:05.000Z") } });
        expect(content.validate("pages", { publishedAt: 1700000000000 }, "update")).toMatchObject({ ok: true, data: { publishedAt: 1700000000000 } });
      });

      it("checks enum options", () => {
        expect(content.validate("pages", { status: "published" }, "update").ok).toBe(true);
        const r = content.validate("pages", { status: "archived" }, "update");
        expect(r).toEqual({ ok: false, errors: [{ field: "status", message: 'expected one of draft, finished, published' }] });
      });

      it("ref fields hold a non-empty string id; existence is a separate module's job", () => {
        expect(content.validate("pages", { hero: "m1" }, "update")).toEqual({ ok: true, data: { hero: "m1" } });
        expect(content.validate("pages", { hero: "" }, "update").ok).toBe(false);
        expect(content.validate("pages", { hero: 5 }, "update").ok).toBe(false);
      });

      it("rejects id and timestamps in data", () => {
        const r = content.validate("pages", { slug: "a", title: "a", id: "x", createdAt: 1 }, "create");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["createdAt", "id"]);
      });
    });

    describe("multi", () => {
      it("create sets id and timestamps and returns the document", async () => {
        const doc = expectOk(await content.create("pages", { slug: "home", title: "Home" }));
        expect(typeof doc.id).toBe("string");
        expect(doc.createdAt).toBeGreaterThan(0);
        expect(doc.updatedAt).toBe(doc.createdAt);
        expect(doc).toMatchObject({ slug: "home", title: "Home" });
        expect(expectOk(await content.get("pages", doc.id))).toEqual(doc);
      });

      it("create with invalid data reports the field errors", async () => {
        const error = expectErr(await content.create("pages", { title: "x" }), "VALIDATION");
        expect(error.message).toMatch(/slug/);
        expect(fieldsOf(error)).toEqual(["slug"]);
      });

      it("unique fields are enforced", async () => {
        expectOk(await content.create("pages", { slug: "home", title: "A" }));
        expect(fieldsOf(expectErr(await content.create("pages", { slug: "home", title: "B" }), "VALIDATION"))).toEqual(["slug"]);
        const other = expectOk(await content.create("pages", { slug: "other", title: "C" }));
        expect(fieldsOf(expectErr(await content.update("pages", other.id, { slug: "home" }), "VALIDATION"))).toEqual(["slug"]);
      });

      it("get of unknown id returns null", async () => {
        expect(expectOk(await content.get("pages", "missing"))).toBeNull();
      });

      it("list filters, sorts and pages", async () => {
        expectOk(await content.create("pages", { slug: "a", title: "A", order: 3, published: true }));
        expectOk(await content.create("pages", { slug: "b", title: "B", order: 1, published: false }));
        expectOk(await content.create("pages", { slug: "c", title: "C", order: 2, published: true }));
        const all = expectOk(await content.list("pages", {}, { sort: { order: "asc" } }));
        expect(all.total).toBe(3);
        expect(all.items.map((d) => d.slug)).toEqual(["b", "c", "a"]);
        const pub = expectOk(await content.list("pages", { published: true }, { sort: { order: "desc" }, limit: 1 }));
        expect(pub.total).toBe(2);
        expect(pub.items.map((d) => d.slug)).toEqual(["a"]);
      });

      it("update validates, merges and bumps updatedAt", async () => {
        const doc = expectOk(await content.create("pages", { slug: "home", title: "Home" }));
        await new Promise((r) => setTimeout(r, 2));
        const updated = expectOk(await content.update("pages", doc.id, { title: "Start" }));
        expect(updated).toMatchObject({ id: doc.id, slug: "home", title: "Start", createdAt: doc.createdAt });
        expect(updated.updatedAt).toBeGreaterThan(doc.updatedAt);
        expect(fieldsOf(expectErr(await content.update("pages", doc.id, { title: 5 }), "VALIDATION"))).toEqual(["title"]);
        expect(expectErr(await content.update("pages", "missing", { title: "x" }), "NOT_FOUND").message).toMatch(/missing/);
      });

      it("remove deletes and is idempotent", async () => {
        const doc = expectOk(await content.create("pages", { slug: "home", title: "Home" }));
        expectOk(await content.remove("pages", doc.id));
        expectOk(await content.remove("pages", doc.id));
        expect(expectOk(await content.get("pages", doc.id))).toBeNull();
      });

      it("set is not allowed on multi types", async () => {
        await expect(content.set("pages", { slug: "a", title: "a" })).rejects.toThrow(/multi/);
      });
    });

    describe("single", () => {
      it("get without id returns null until set", async () => {
        expect(expectOk(await content.get("settings"))).toBeNull();
        const doc = expectOk(await content.set("settings", { title: "My Site" }));
        expect(doc).toMatchObject({ title: "My Site" });
        expect(expectOk(await content.get("settings"))).toEqual(doc);
      });

      it("set replaces the document but keeps id and createdAt", async () => {
        const first = expectOk(await content.set("settings", { title: "A", navigation: [1] }));
        await new Promise((r) => setTimeout(r, 2));
        const second = expectOk(await content.set("settings", { title: "B" }));
        expect(second.id).toBe(first.id);
        expect(second.createdAt).toBe(first.createdAt);
        expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
        expect(second.title).toBe("B");
        expect(second.navigation ?? null).toBeNull();
      });

      it("set validates required fields", async () => {
        expect(fieldsOf(expectErr(await content.set("settings", { navigation: [] }), "VALIDATION"))).toEqual(["title"]);
      });

      it("create is not allowed on single types", async () => {
        await expect(content.create("settings", { title: "x" })).rejects.toThrow(/single/);
      });

      it("update works on the single document", async () => {
        const doc = expectOk(await content.set("settings", { title: "A", navigation: [1] }));
        const updated = expectOk(await content.update("settings", doc.id, { title: "B" }));
        expect(updated).toMatchObject({ id: doc.id, title: "B", navigation: [1] });
      });
    });

    describe("i18n", () => {
      let i18n: Content;
      beforeEach(async () => {
        i18n = await make(CONTENT_I18N_MODEL);
      });

      it("rejects unknown locales", async () => {
        expect(expectErr(await i18n.create("pages", { slug: "a", title: "A", status: "draft" }, { locale: "fr" }), "VALIDATION").message).toMatch(/locale/);
        expect(expectErr(await i18n.get("pages", "any", { locale: "fr" }), "VALIDATION").message).toMatch(/locale/);
      });

      it("writes the given locale and resolves it on read, defaulting to defaultLocale", async () => {
        const de = expectOk(await i18n.create("pages", { slug: "start", title: "Start", status: "draft" }, { locale: "de" }));
        expect(de).toMatchObject({ slug: "start", title: "Start", status: "draft" });
        expectOk(await i18n.update("pages", de.id, { slug: "home", title: "Home" }, { locale: "en" }));
        expect(expectOk(await i18n.get("pages", de.id, { locale: "en" }))).toMatchObject({ slug: "home", title: "Home", status: "draft" });
        expect(expectOk(await i18n.get("pages", de.id, { locale: "de" }))).toMatchObject({ slug: "start", title: "Start" });
        expect(expectOk(await i18n.get("pages", de.id))).toMatchObject({ slug: "start", title: "Start" });
      });

      it("is strict by default: missing translations are null", async () => {
        const doc = expectOk(await i18n.create("pages", { slug: "start", title: "Start", body: { blocks: [] }, status: "draft" }));
        expect(expectOk(await i18n.get("pages", doc.id, { locale: "en" }))).toMatchObject({ slug: null, title: null, body: null, status: "draft" });
        expect(expectOk(await i18n.get("pages", doc.id, { locale: "en" }))?._locales).toBeUndefined();
      });

      it("falls back to the default locale on request and says where values came from", async () => {
        const doc = expectOk(await i18n.create("pages", { slug: "start", title: "Start", body: { blocks: [] }, status: "draft" }));
        expectOk(await i18n.update("pages", doc.id, { title: "Home" }, { locale: "en" }));
        const en = expectOk(await i18n.get("pages", doc.id, { locale: "en", fallback: true }));
        expect(en).toMatchObject({ slug: "start", title: "Home", body: { blocks: [] } });
        expect(en?._locales).toEqual({ slug: "de", title: "en", body: "de" });
        const list = expectOk(await i18n.list("pages", {}, { locale: "en", fallback: true }));
        expect(list.items[0]?._locales).toEqual({ slug: "de", title: "en", body: "de" });
      });

      it("required applies per locale on create only", () => {
        const r = i18n.validate("pages", { status: "draft" }, "create", { locale: "en" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(["slug", "title"]);
      });

      it("unique applies per locale", async () => {
        expectOk(await i18n.create("pages", { slug: "start", title: "A", status: "draft" }, { locale: "de" }));
        expect(fieldsOf(expectErr(await i18n.create("pages", { slug: "start", title: "B", status: "draft" }, { locale: "de" }), "VALIDATION"))).toEqual(["slug"]);
        expect(expectOk(await i18n.create("pages", { slug: "start", title: "B", status: "draft" }, { locale: "en" }))).toMatchObject({ slug: "start" });
      });

      it("filters and sorts localized fields in the requested locale", async () => {
        const a = expectOk(await i18n.create("pages", { slug: "a-de", title: "Zeta", status: "published" }, { locale: "de" }));
        expectOk(await i18n.update("pages", a.id, { slug: "a-en", title: "Alpha" }, { locale: "en" }));
        expectOk(await i18n.create("pages", { slug: "b-de", title: "Beta", status: "published" }, { locale: "de" }));
        const de = expectOk(await i18n.list("pages", { status: "published" }, { locale: "de", sort: { title: "asc" } }));
        expect(de.items.map((d) => d.slug)).toEqual(["b-de", "a-de"]);
        const enStrict = expectOk(await i18n.list("pages", { status: "published" }, { locale: "en", sort: { title: "asc" } }));
        expect(enStrict.items.map((d) => d.slug).sort()).toEqual(["a-en", null]);
        const en = expectOk(await i18n.list("pages", { slug: "a-en" }, { locale: "en" }));
        expect(en.total).toBe(1);
        expect(en.items[0]?.title).toBe("Alpha");
      });

      it("completeWhen: a locale can only reach the state when its required localized fields are present", async () => {
        const pub = await make(CONTENT_PUBLISH_MODEL);
        const doc = expectOk(await pub.create("pages", { slug: "start", title: "Start", status: "published" }));
        expect(expectErr(await pub.update("pages", doc.id, { status: "published" }, { locale: "en" }), "VALIDATION").message).toMatch(/status cannot be "published" for en: slug, title missing/);
        expectOk(await pub.update("pages", doc.id, { title: "Home" }, { locale: "en" }));
        expect(expectErr(await pub.update("pages", doc.id, { status: "published" }, { locale: "en" }), "VALIDATION").message).toMatch(/for en: slug missing/);
        expectOk(await pub.update("pages", doc.id, { slug: "home", status: "published" }, { locale: "en" }));
        expect(expectOk(await pub.get("pages", doc.id, { locale: "en" }))?.status).toBe("published");
        expect(fieldsOf(expectErr(await pub.create("pages", { slug: "x", status: "published" }, { locale: "en" }), "VALIDATION"))).toEqual(["title"]);
        expect(pub.validate("pages", { status: "published" }, "update", { locale: "en" }).ok).toBe(true);
      });

      it("reports which translations exist (required localized fields present)", async () => {
        const doc = expectOk(await i18n.create("pages", { slug: "start", title: "Start", status: "draft" }));
        expect(doc._translations).toEqual({ de: true, en: false });
        expectOk(await i18n.update("pages", doc.id, { title: "Home" }, { locale: "en" }));
        expect(expectOk(await i18n.get("pages", doc.id, { locale: "en" }))?._translations).toEqual({ de: true, en: false });
        expectOk(await i18n.update("pages", doc.id, { slug: "home" }, { locale: "en" }));
        expect(expectOk(await i18n.get("pages", doc.id))?._translations).toEqual({ de: true, en: true });
        expect(expectOk(await i18n.list("pages")).items[0]?._translations).toEqual({ de: true, en: true });
        expect(expectOk(await content.create("pages", { slug: "x", title: "x" }))._translations).toBeUndefined();
      });

      it("removes one translation and keeps the others, the default locale included", async () => {
        const pub = await make(CONTENT_PUBLISH_MODEL);
        const doc = expectOk(await pub.create("pages", { slug: "kontakt", title: "Kontakt", status: "published" }));
        expectOk(await pub.update("pages", doc.id, { slug: "contact", title: "Contact", status: "published" }, { locale: "en" }));
        const after = expectOk(await pub.removeTranslation("pages", doc.id, "en"));
        expect(after).toMatchObject({ id: doc.id, slug: "kontakt", title: "Kontakt", status: "published", _translations: { de: true, en: false } });
        expect(expectOk(await pub.get("pages", doc.id, { locale: "en" }))).toMatchObject({ slug: null, title: null, status: null });
        expect(expectErr(await pub.removeTranslation("pages", doc.id, "en"), "NOT_FOUND").message).toMatch(/no en translation/);
        expect(expectErr(await pub.removeTranslation("pages", doc.id, "de"), "CONFLICT").message).toMatch(/last translation/);
        expect(expectErr(await pub.removeTranslation("pages", doc.id, "fr"), "VALIDATION").message).toMatch(/unknown locale/);
        expect(expectErr(await pub.removeTranslation("pages", "missing", "en"), "NOT_FOUND").message).toMatch(/not found/);
        expectOk(await pub.update("pages", doc.id, { slug: "contact", title: "Contact", status: "published" }, { locale: "en" }));
        expect(expectOk(await pub.removeTranslation("pages", doc.id, "de"))._translations).toEqual({ de: false, en: true });
        expect(expectOk(await pub.list("pages", { status: "published" }, { locale: "en" })).items.map((d) => d.slug)).toEqual(["contact"]);
        expect(expectOk(await pub.list("pages", { status: "published" })).items).toEqual([]);
      });

      it("stores values identical to the default locale for another locale, translation complete once every required field is set", async () => {
        const pub = await make({ ...CONTENT_PUBLISH_MODEL, types: { pages: { ...CONTENT_PUBLISH_MODEL.types.pages!, fields: { ...CONTENT_PUBLISH_MODEL.types.pages!.fields, status: { type: "enum", options: ["draft", "published"], required: true, localized: true } } } } });
        const doc = expectOk(await pub.create("pages", { slug: "v1", title: "V", status: "draft" }));
        const partial = expectOk(await pub.update("pages", doc.id, { slug: "v1", title: "V" }, { locale: "en" }));
        expect(partial).toMatchObject({ slug: "v1", title: "V", status: null, _translations: { de: true, en: false } });
        expect(expectOk(await pub.get("pages", doc.id, { locale: "en" }))).toMatchObject({ slug: "v1", title: "V", status: null });
        const complete = expectOk(await pub.update("pages", doc.id, { status: "draft" }, { locale: "en" }));
        expect(complete._translations).toEqual({ de: true, en: true });
        expect(expectOk(await pub.get("pages", doc.id, { locale: "en", fallback: true }))?._locales).toEqual({ slug: "en", title: "en", status: "en" });
      });

      it("removeTranslation leaves non-localized fields untouched", async () => {
        const doc = expectOk(await i18n.create("pages", { slug: "start", title: "Start", status: "draft", body: { de: 1 } }));
        expectOk(await i18n.update("pages", doc.id, { slug: "home", title: "Home", status: "draft" }, { locale: "en" }));
        const after = expectOk(await i18n.removeTranslation("pages", doc.id, "en"));
        expect(after).toMatchObject({ status: "draft", body: { de: 1 }, _translations: { de: true, en: false } });
        expect(expectOk(await i18n.get("pages", doc.id, { locale: "en" }))?.status).toBe("draft");
        expect(expectOk(await i18n.get("pages", doc.id, { locale: "en" }))?.body).toBeNull();
      });

      it("localized fields without locales in the model are rejected", async () => {
        await expect(make({ types: { pages: { kind: "multi", fields: { title: { type: "text", localized: true } } } } })).rejects.toThrow(/locales/);
      });
    });
  });
}
