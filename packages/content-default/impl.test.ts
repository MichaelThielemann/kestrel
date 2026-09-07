import { describe, it, expect } from "vitest";
import { contentContractTests } from "@michaelthielemann/kestrel-contracts/content.contract.test";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext, type Context } from "@michaelthielemann/kestrel/context";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import type { Result } from "@michaelthielemann/kestrel/result";
import { createContentDefault, validateModel } from "./impl.ts";
import module from "./module.ts";

contentContractTests((model) => createContentDefault(model, createFakePersistence()));

const ctx = (params: Record<string, string> = {}, payload: Record<string, unknown> = {}): Context => createContext({ trigger: { kind: "http", name: "t" }, params, payload });

const resultOf = (step: Result<Context, KestrelError>): Record<string, unknown> => expectOk(step).result as Record<string, unknown>;

describe("content/default", () => {
  it("rejects reserved field names and bad type names in the model", () => {
    expect(() => validateModel({ types: { pages: { kind: "multi", fields: { id: "text" } } } })).toThrow(/reserved/);
    expect(() => validateModel({ types: { "Bad Name": { kind: "multi", fields: {} } } })).toThrow(/invalid type name/);
  });

  it("rejects enums without options and localized fields without locales", () => {
    expect(() => validateModel({ types: { pages: { kind: "multi", fields: { status: { type: "enum" } } } } })).toThrow(/needs options/);
    expect(() => validateModel({ types: { pages: { kind: "multi", fields: { title: { type: "text", localized: true } } } } })).toThrow(/locales/);
    expect(() => validateModel({ locales: ["de"], types: {} })).toThrow(/defaultLocale/);
    expect(() => validateModel({ types: { pages: { kind: "multi", fields: { hero: { type: "ref" } } } } })).toThrow(/needs a target/);
  });

  it("rejects an unknown sort field with VALIDATION, not a thrown error", async () => {
    const content = await createContentDefault({ types: { notes: { kind: "multi", fields: { text: "text" } } } }, createFakePersistence());
    const error = expectErr(await content.list("notes", {}, { sort: { nope: "asc" } }), "VALIDATION");
    expect(error.status).toBe(400);
    expect(error.message).toMatch(/unknown sort field "nope"/);
    expect(expectOk(await content.list("notes", {}, { sort: { updatedAt: "desc" } }))).toMatchObject({ total: 0 });
  });

  it("uses the injected clock for timestamps", async () => {
    const content = await createContentDefault({ types: { notes: { kind: "multi", fields: { text: "text" } } } }, createFakePersistence(), () => 42);
    expect(expectOk(await content.create("notes", { text: "x" }))).toMatchObject({ createdAt: 42, updatedAt: 42 });
  });

  it("maps a unique constraint that slips past the pre-check to the same field error", async () => {
    const db = createFakePersistence();
    const content = await createContentDefault({ locales: ["de", "en"], defaultLocale: "de", types: { pages: { kind: "multi", fields: { slug: { type: "slug", required: true, unique: true, localized: true } } } } }, db);
    const results = await Promise.all([content.create("pages", { slug: "home" }), content.create("pages", { slug: "home" })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok ? failed.error : null).toMatchObject({ code: "VALIDATION", status: 400, message: 'pages: slug must be unique, "home" exists', details: { fields: [{ field: "slug", message: 'must be unique, "home" exists' }] } });
    expectOk(await content.create("pages", { slug: "home" }, { locale: "en" }));
    expectErr(await db.createOne("pages", { slug__de: "home" }), "CONFLICT");
  });

  describe("removeTranslation step", () => {
    const model = {
      locales: ["de", "en"],
      defaultLocale: "de",
      types: { pages: { kind: "multi" as const, fields: { slug: { type: "slug" as const, required: true, localized: true }, title: { type: "text" as const, localized: true } } } },
    };

    it("answers VALIDATION for an unknown locale, NOT_FOUND for a missing translation and CONFLICT for the last one", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      const doc = expectOk(await content.create("pages", { slug: "a", title: "A" }));
      expectOk(await content.update("pages", doc.id, { slug: "a-en" }, { locale: "en" }));
      const step = module.steps!(content).removeTranslation("pages");

      expect(expectErr(await step(ctx({ id: doc.id })), "VALIDATION").message).toBe("missing locale");
      expect(expectErr(await step(ctx({ id: doc.id, locale: "fr" })), "VALIDATION").message).toBe('pages: locale unknown locale "fr"');
      expect(expectErr(await step(ctx({ id: "nope", locale: "en" })), "NOT_FOUND").message).toBe("pages/nope not found");
      expect(resultOf(await step(ctx({ id: doc.id, locale: "en" })))).toMatchObject({ slug: "a", _translations: { de: true, en: false } });
      expect(expectErr(await step(ctx({ id: doc.id, locale: "en" })), "NOT_FOUND").message).toMatch(/has no en translation/);
      const last = expectErr(await step(ctx({ id: doc.id, locale: "de" })), "CONFLICT");
      expect(last.status).toBe(409);
      expect(last.message).toMatch(/last translation – remove the document/);
      expect(expectErr(await step(ctx()), "VALIDATION").message).toBe("missing id");
    });
  });

  describe("validation failures", () => {
    const model = { types: { pages: { kind: "multi" as const, fields: { slug: { type: "slug" as const, required: true, unique: true }, title: { type: "text" as const } } } } };

    it("passes the field errors of the validate step as details", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      const validate = module.steps!(content).validate("pages");
      const error = expectErr(await validate(ctx({}, { title: "x" })), "VALIDATION");
      expect(error.details).toEqual({ fields: [{ field: "slug", message: "required" }] });
      expect(error.message).toBe("pages: slug required");
      expect(expectOk(await validate(ctx({}, { slug: "home" }))).result).toBeUndefined();
    });

    it("passes the field errors of a rejected create as details", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      expectOk(await content.create("pages", { slug: "home" }));
      const create = module.steps!(content).create("pages");
      const error = expectErr(await create(ctx({}, { slug: "home" })), "VALIDATION");
      expect(error.details).toEqual({ fields: [{ field: "slug", message: 'must be unique, "home" exists' }] });
      expect(error.message).toBe('pages: slug must be unique, "home" exists');
    });

    it("answers NOT_FOUND when the updated document does not exist", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      const update = module.steps!(content).update("pages");
      expect(expectErr(await update(ctx({ id: "nope" }, { title: "x" })), "NOT_FOUND").message).toBe("pages/nope not found");
      expect(expectErr(await update(ctx({}, { title: "x" })), "VALIDATION").message).toBe("missing id");
    });
  });

  describe("list step", () => {
    const model = { types: { notes: { kind: "multi" as const, fields: { text: "text" as const } } } };
    const listStep = async (maxLimit = 200) => {
      const content = { ...(await createContentDefault(model, createFakePersistence())), maxLimit };
      return module.steps!(content).list("notes");
    };

    it("rejects a non-integer limit, an oversized limit, a negative offset and an unknown sort field with VALIDATION", async () => {
      const list = await listStep(50);
      expect(expectErr(await list(ctx({}, { limit: "abc" })), "VALIDATION").message).toBe("content/default: limit must be an integer");
      expect(expectErr(await list(ctx({}, { limit: "1.5" })), "VALIDATION").message).toBe("content/default: limit must be an integer");
      expect(expectErr(await list(ctx({}, { limit: "0" })), "VALIDATION").message).toBe("content/default: limit must be at least 1");
      expect(expectErr(await list(ctx({}, { limit: "51" })), "VALIDATION").message).toBe("content/default: limit must not exceed 50");
      expect(expectErr(await list(ctx({}, { offset: "x" })), "VALIDATION").message).toBe("content/default: offset must be an integer");
      expect(expectErr(await list(ctx({}, { offset: "-1" })), "VALIDATION").message).toBe("content/default: offset must not be negative");
      const sort = expectErr(await list(ctx({}, { sort: "nope" })), "VALIDATION");
      expect(sort.status).toBe(400);
      expect(sort.message).toMatch(/^content\/default: unknown sort field "nope"/);
    });

    it("accepts valid list parameters and an absent one", async () => {
      const list = await listStep(50);
      expect(resultOf(await list(ctx({}, { limit: "50", offset: "0", sort: "-updatedAt" })))).toMatchObject({ items: [], total: 0 });
      expect(resultOf(await list(ctx({}, { limit: 10 })))).toMatchObject({ items: [], total: 0 });
      expect(resultOf(await list(ctx()))).toMatchObject({ items: [], total: 0 });
    });

    it("describes limit with the configured maximum", async () => {
      const content = { ...(await createContentDefault(model, createFakePersistence())), maxLimit: 25 };
      expect(module.describe!(content).list("notes").query?.limit).toEqual({ type: "integer", minimum: 1, maximum: 25 });
    });
  });

  describe("get step", () => {
    const model = {
      locales: ["de", "en"],
      defaultLocale: "de",
      types: { pages: { kind: "multi" as const, fields: { slug: { type: "slug" as const, required: true }, status: { type: "enum" as const, options: ["draft", "published"], localized: true } } } },
    };

    it("enforces the fixed filter: a published page is returned, a draft and an unpublished locale both NOT_FOUND", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      const published = expectOk(await content.create("pages", { slug: "a", status: "published" }));
      expectOk(await content.update("pages", published.id, { status: "published" }, { locale: "en" }));
      const draft = expectOk(await content.create("pages", { slug: "b", status: "draft" }));
      const deOnly = expectOk(await content.create("pages", { slug: "c", status: "published" }));
      const get = module.steps!(content).get("pages?status=published");
      expect(resultOf(await get(ctx({ id: published.id })))).toMatchObject({ slug: "a", status: "published" });
      expectErr(await get(ctx({ id: draft.id })), "NOT_FOUND");
      expectErr(await get(ctx({ id: deOnly.id, locale: "en" })), "NOT_FOUND");
    });

    it("answers VALIDATION for an unknown locale", async () => {
      const content = await createContentDefault(model, createFakePersistence());
      const doc = expectOk(await content.create("pages", { slug: "a", status: "published" }));
      const error = expectErr(await module.steps!(content).get("pages")(ctx({ id: doc.id, locale: "fr" })), "VALIDATION");
      expect(error.status).toBe(400);
      expect(error.message).toMatch(/unknown locale "fr"/);
    });

    it("returns an empty document instead of NOT_FOUND for a single type that was never set", async () => {
      const single = { ...model, types: { settings: { kind: "single" as const, fields: { title: { type: "text" as const, localized: true } } } } };
      const content = await createContentDefault(single, createFakePersistence());
      const steps = module.steps!(content);
      const get = steps.get("settings");
      expect(resultOf(await get(ctx({ id: "" })))).toEqual({ title: null, _translations: { de: false, en: false } });
      expect(resultOf(await steps.get("settings?fallback=true")(ctx({ id: "", locale: "en" })))).toEqual({ title: null, _locales: {}, _translations: { de: false, en: false } });
      expectOk(await content.set("settings", { title: "Hi" }));
      expect(resultOf(await get(ctx({ id: "" })))).toMatchObject({ title: "Hi" });
      const fresh = await createContentDefault(single, createFakePersistence());
      expectErr(await module.steps!(fresh).get("settings?title=Hi")(ctx({ id: "" })), "NOT_FOUND");
      expect(resultOf(await steps.get("settings?title=Hi")(ctx({ id: "" })))).toMatchObject({ title: "Hi" });
      const noLocales = await createContentDefault({ types: { settings: { kind: "single" as const, fields: { title: "text" as const } } } }, createFakePersistence());
      expect(resultOf(await module.steps!(noLocales).get("settings")(ctx({ id: "" })))).toEqual({ title: null });
    });

    it("declares params.id only for multi types", async () => {
      const content = await createContentDefault({ ...model, types: { ...model.types, settings: { kind: "single" as const, fields: { title: "text" as const } } } }, createFakePersistence());
      const described = module.describe!({ ...content, maxLimit: 200 });
      expect(described.get("pages").reads).toEqual(["params.id"]);
      expect(described.get("settings").reads).toEqual([]);
      expect(described.get("settings").errors).toEqual({ 400: "unknown locale" });
      expect(described.get("settings?title=Hi").errors).toEqual({ 400: "unknown locale", 404: "not found" });
    });
  });

  describe("transient persistence failures", () => {
    const model = {
      locales: ["de", "en"],
      defaultLocale: "de",
      types: {
        notes: { kind: "multi" as const, fields: { text: { type: "text" as const, required: true, localized: true } } },
        settings: { kind: "single" as const, fields: { title: "text" as const } },
      },
    };

    it("every contract-backed step answers a retryable 503", async () => {
      const db = createFakePersistence();
      const content = { ...(await createContentDefault(model, db)), maxLimit: 200 };
      const steps = module.steps!(content);
      const note = expectOk(await content.create("notes", { text: "x" }));
      const calls: Array<() => Promise<Result<Context, KestrelError>>> = [
        () => steps.create("notes")(ctx({}, { text: "x" })),
        () => steps.set("settings")(ctx({}, { title: "x" })),
        () => steps.get("notes")(ctx({ id: note.id })),
        () => steps.list("notes")(ctx()),
        () => steps.update("notes")(ctx({ id: note.id }, { text: "y" })),
        () => steps.remove("notes")(ctx({ id: note.id })),
        () => steps.removeTranslation("notes")(ctx({ id: note.id, locale: "en" })),
      ];
      for (const call of calls) {
        db.failNext("TRANSIENT");
        const error = expectErr(await call(), "TRANSIENT");
        expect(error.status).toBe(503);
        expect(error.retryable).toBe(true);
      }
    });
  });
});
