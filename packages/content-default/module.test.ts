import { describe, expect, it } from "vitest";
import type { ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, Step, StepFactory } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import validateModule, { configSchema as validateConfigSchema } from "@michaelthielemann/kestrel-validate-jsonschema";
import module, { configSchema } from "./module.ts";

const MODEL = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    notes: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], required: true },
      },
    },
    settings: { kind: "single", fields: { title: { type: "text" } } },
  },
};

async function boot() {
  const db = createFakePersistence();
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
  };
  const config = configSchema.parse(MODEL);
  const instance = await module.setup(config, deps);
  return { instance, db };
}

function run(steps: string[], input: Record<string, unknown>, instance: unknown, extraSteps: Record<string, Step | StepFactory> = {}): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }], steps: extraSteps });
}

describe("content/default module steps", () => {
  it("validate accepts a matching payload and leaves it unchanged for the next step", async () => {
    const { instance } = await boot();
    const payload = { slug: "a", title: "A", status: "draft" };
    const echo = { "test.echo": async (ctx: Context) => ok({ ...ctx, result: ctx.payload }) };
    const res = await run(["content.validate:notes", "test.echo"], { body: payload }, instance, echo);
    expect(res.status).toBe(200);
    expect(res.result).toEqual(payload);
  });

  it("create stores a document", async () => {
    const { instance } = await boot();
    const res = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<ContentDocument>(res.result, "host").slug).toBe("a");
  });

  it("get reads a document by id", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    const res = await run(["content.get:notes"], { params: { id }, query: { locale: "de" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<ContentDocument>(res.result, "host").slug).toBe("a");
  });

  it("list pages through the documents of a type", async () => {
    const { instance } = await boot();
    await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const res = await run(["content.list:notes"], { query: { limit: "10", offset: "0", sort: "slug" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<{ total: number }>(res.result, "host").total).toBe(1);
  });

  it("update changes a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    const res = await run(["content.update:notes"], { params: { id }, body: { status: "published" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<ContentDocument>(res.result, "host").status).toBe("published");
  });

  it("removeTranslation drops one locale of a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    await run(["content.update:notes"], { params: { id }, body: { title: "A-en" }, query: { locale: "en" } }, instance);
    const res = await run(["content.removeTranslation:notes"], { params: { id }, query: { locale: "en" } }, instance);
    expect(res.status).toBe(200);
  });

  it("describeModel answers the parsed model without maxLimit", async () => {
    const { instance } = await boot();
    const res = await run(["content.describeModel"], {}, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual(MODEL);
  });

  it("remove deletes a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    const res = await run(["content.remove:notes"], { params: { id } }, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ ok: true });
  });

  it("set replaces the settings singleton", async () => {
    const { instance } = await boot();
    const res = await run(["content.set:settings"], { body: { title: "My Site" } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<ContentDocument>(res.result, "host").title).toBe("My Site");
  });

  it("accepts null for optional fields on create and set, and for every field on update, but not for a required field on create", async () => {
    const { instance } = await boot();
    const settings = await run(["content.set:settings"], { body: { title: null } }, instance);
    expect(settings.status).toBe(200);
    expect(boundaryCast<ContentDocument>(settings.result, "host").title).toBeNull();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    expect(created.status).toBe(200);
    const cleared = await run(["content.update:notes"], { params: { id: boundaryCast<ContentDocument>(created.result, "host").id }, body: { title: null } }, instance);
    expect(cleared.status).toBe(200);
    const missing = await run(["content.create:notes"], { body: { slug: "b", title: null, status: "draft" } }, instance);
    expect(missing).toMatchObject({ status: 400, code: "VALIDATION", step: "content.create:notes" });
    expect(missing.details?.problems).toEqual([{ path: "$.title", message: "expected string, got null" }]);
  });

  it("rejects a non-integer limit with 400 VALIDATION from the query schema", async () => {
    const { instance } = await boot();
    const res = await run(["content.list:notes"], { query: { limit: "abc" } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details?.problems).toEqual([{ path: "$.limit", message: "expected integer, got string" }]);
  });
});

const CUSTOM_TYPE_MODEL = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true },
        title: { type: "text", required: true, localized: true },
        accent: { type: "text" },
        cta: { type: "json", localized: true },
      },
    },
  },
};

const CUSTOM_TYPE_SCHEMAS = {
  "pages.accent": { type: "string", pattern: "^#[0-9a-f]{6}$" },
  "pages.cta": { type: "object", properties: { href: { type: "string" }, label: { type: "string" } }, required: ["href", "label"], additionalProperties: false },
};

const CREATE_PAGE = ["validate.check:pages.accent", "validate.check:pages.cta", "content.create:pages"];
const UPDATE_PAGE = ["validate.check:pages.accent", "validate.check:pages.cta", "content.update:pages"];

async function bootWithValidator() {
  const db = createFakePersistence();
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
  };
  const content = await module.setup(configSchema.parse(CUSTOM_TYPE_MODEL), deps);
  const validator = await validateModule.setup(validateConfigSchema.parse({ schemas: CUSTOM_TYPE_SCHEMAS }), deps);
  return { content, validator };
}

function runWithValidator(steps: string[], input: Record<string, unknown>, content: unknown, validator: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, {
    modules: [
      { module, instance: content },
      { module: validateModule, instance: validator },
    ],
  });
}

describe("content/default carries a custom field type as its storage type", () => {
  it("refuses a config that still names the custom type, naming the field", () => {
    const parsed = configSchema.safeParse({ types: { pages: { kind: "multi", fields: { accent: { type: "color" } } } } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path.join(".")).toBe("types.pages.fields.accent");
  });

  it("boots with the resolved model, stores the values and describes the storage type", async () => {
    const { content, validator } = await bootWithValidator();
    const created = await runWithValidator(CREATE_PAGE, { body: { slug: "a", title: "A", accent: "#2266cc", cta: { href: "/x", label: "X" } } }, content, validator);
    expect(created.status).toBe(200);
    const doc = boundaryCast<ContentDocument>(created.result, "host");
    expect(doc.accent).toBe("#2266cc");
    expect(doc.cta).toEqual({ href: "/x", label: "X" });

    const described = await runWithValidator(["content.describeModel"], {}, content, validator);
    expect(boundaryCast<{ types: { pages: { fields: Record<string, unknown> } } }>(described.result, "host").types.pages.fields).toMatchObject({ accent: { type: "text" }, cta: { type: "json", localized: true } });
  });

  it("answers an invalid value with 400 VALIDATION naming the field", async () => {
    const { content, validator } = await bootWithValidator();
    const res = await runWithValidator(CREATE_PAGE, { body: { slug: "a", title: "A", accent: "rebeccapurple" } }, content, validator);
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", step: "validate.check:pages.accent" });
    expect(res.details?.fields).toEqual([{ field: "accent", message: 'must match pattern "^#[0-9a-f]{6}$"' }]);
    expect(res.details?.problems).toEqual([{ path: "/", message: 'must match pattern "^#[0-9a-f]{6}$"' }]);
    expect(res.error).toContain("pages.accent");
  });

  it("names a json-backed field whose object shape is wrong", async () => {
    const { content, validator } = await bootWithValidator();
    const res = await runWithValidator(CREATE_PAGE, { body: { slug: "a", title: "A", cta: { href: "/x" } } }, content, validator);
    expect(res).toMatchObject({ status: 400, code: "VALIDATION", step: "validate.check:pages.cta" });
    expect(res.details?.fields).toEqual([{ field: "cta", message: "must have required property 'label'" }]);
  });

  it("validates and stores a localized custom field per locale", async () => {
    const { content, validator } = await bootWithValidator();
    const created = await runWithValidator(CREATE_PAGE, { body: { slug: "a", title: "A", cta: { href: "/de", label: "DE" } } }, content, validator);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;

    const broken = await runWithValidator(UPDATE_PAGE, { params: { id }, body: { title: "A-en", cta: { href: "/en" } }, query: { locale: "en" } }, content, validator);
    expect(broken).toMatchObject({ status: 400, code: "VALIDATION", step: "validate.check:pages.cta" });
    expect(broken.details?.fields).toEqual([{ field: "cta", message: "must have required property 'label'" }]);

    const updated = await runWithValidator(UPDATE_PAGE, { params: { id }, body: { title: "A-en", cta: { href: "/en", label: "EN" } }, query: { locale: "en" } }, content, validator);
    expect(updated.status).toBe(200);
    expect(boundaryCast<ContentDocument>(updated.result, "host").cta).toEqual({ href: "/en", label: "EN" });

    const german = await runWithValidator(["content.get:pages"], { params: { id }, query: { locale: "de" } }, content, validator);
    expect(boundaryCast<ContentDocument>(german.result, "host").cta).toEqual({ href: "/de", label: "DE" });
  });

  it("leaves required-ness to the content model: an absent or null custom field passes the schema check", async () => {
    const { content, validator } = await bootWithValidator();
    const absent = await runWithValidator(CREATE_PAGE, { body: { slug: "a", title: "A" } }, content, validator);
    expect(absent.status).toBe(200);
    expect(boundaryCast<ContentDocument>(absent.result, "host").accent).toBeNull();

    const cleared = await runWithValidator(CREATE_PAGE, { body: { slug: "b", title: "B", accent: null } }, content, validator);
    expect(cleared.status).toBe(200);
    expect(boundaryCast<ContentDocument>(cleared.result, "host").accent).toBeNull();
  });
});
