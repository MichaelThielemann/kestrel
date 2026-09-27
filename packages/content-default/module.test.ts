import { describe, expect, it } from "vitest";
import { z } from "zod";
import { boot as bootKestrel, checkBoot, defineModule, KestrelBootError } from "@michaelthielemann/kestrel";
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

async function boot(extra: Record<string, unknown> = {}) {
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
    eventTriggers: [],
  };
  const config = configSchema.parse({ ...MODEL, ...extra });
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

  describe("a list without limit", () => {
    async function seeded(count: number, extra: Record<string, unknown>) {
      const { instance } = await boot(extra);
      for (let i = 0; i < count; i++) await run(["content.create:notes"], { body: { slug: `n${i}`, title: `N${i}`, status: "draft" } }, instance);
      return instance;
    }

    it("answers at most maxLimit items with the full total", async () => {
      const instance = await seeded(7, { maxLimit: 5 });
      const res = await run(["content.list:notes"], {}, instance);
      expect(res.status).toBe(200);
      const page = boundaryCast<{ items: unknown[]; total: number }>(res.result, "host");
      expect(page.items).toHaveLength(5);
      expect(page.total).toBe(7);
    });

    it("answers at most defaultLimit items when it is set below maxLimit", async () => {
      const instance = await seeded(4, { maxLimit: 5, defaultLimit: 2 });
      const page = boundaryCast<{ items: unknown[]; total: number }>((await run(["content.list:notes"], { query: { offset: "1" } }, instance)).result, "host");
      expect(page.items).toHaveLength(2);
      expect(page.total).toBe(4);
    });

    it("still refuses a limit above maxLimit", async () => {
      const instance = await seeded(1, { maxLimit: 5 });
      const res = await run(["content.list:notes"], { query: { limit: "6" } }, instance);
      expect(res.status).toBe(400);
    });

    it("refuses a defaultLimit above maxLimit at setup", async () => {
      await expect(boot({ maxLimit: 5, defaultLimit: 6 })).rejects.toThrow(/defaultLimit/);
    });

    it("leaves content@1's own list unbounded for callers inside the process", async () => {
      const instance = await seeded(7, { maxLimit: 5 });
      const all = boundaryCast<{ list: (type: string, filter: object) => Promise<{ ok: boolean; value: { items: unknown[] } }> }>(instance, "host");
      const listed = await all.list("notes", {});
      expect(listed.value.items).toHaveLength(7);
    });
  });

  it("rejects a non-integer limit with 400 VALIDATION from the query schema", async () => {
    const { instance } = await boot();
    const res = await run(["content.list:notes"], { query: { limit: "abc" } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details?.problems).toEqual([{ path: "$.limit", message: "expected integer, got string" }]);
  });
});

const PUBLISH_MODEL = {
  locales: ["de", "en"],
  defaultLocale: "de",
  types: {
    pages: {
      kind: "multi",
      fields: {
        slug: { type: "slug", required: true, unique: true, localized: true },
        title: { type: "text", required: true, localized: true },
        status: { type: "enum", options: ["draft", "published"], required: true, localized: true },
      },
    },
  },
};

async function bootPublish() {
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
    eventTriggers: [],
  };
  const instance = await module.setup(configSchema.parse(PUBLISH_MODEL), deps);
  return { instance };
}

describe("content/default: a fixed filter on get/list narrows _translations to it too", () => {
  it("get narrows _translations to the locales that pass the fixed filter", async () => {
    const { instance } = await bootPublish();
    const created = await run(["content.create:pages"], { body: { slug: "oeffentlich", title: "Oeffentlich", status: "published" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    await run(["content.update:pages"], { params: { id }, query: { locale: "en" }, body: { slug: "secret-en", title: "Secret EN", status: "draft" } }, instance);

    const res = await run(["content.get:pages?status=published"], { params: { id } }, instance);
    expect(res.status).toBe(200);
    expect(boundaryCast<ContentDocument>(res.result, "host")._translations).toEqual({ de: true, en: false });
  });

  it("list narrows _translations per item, in one query per other locale", async () => {
    const { instance } = await bootPublish();
    const created = await run(["content.create:pages"], { body: { slug: "oeffentlich", title: "Oeffentlich", status: "published" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    await run(["content.update:pages"], { params: { id }, query: { locale: "en" }, body: { slug: "secret-en", title: "Secret EN", status: "draft" } }, instance);
    await run(["content.create:pages"], { body: { slug: "zweite", title: "Zweite", status: "published" } }, instance);

    const res = await run(["content.list:pages?status=published"], {}, instance);
    expect(res.status).toBe(200);
    const items = boundaryCast<{ items: ContentDocument[]; total: number }>(res.result, "host");
    expect(items.total).toBe(2);
    expect(items.items.find((d) => d.id === id)?._translations).toEqual({ de: true, en: false });
  });

  it("leaves _translations untouched without a fixed filter", async () => {
    const { instance } = await bootPublish();
    const created = await run(["content.create:pages"], { body: { slug: "oeffentlich", title: "Oeffentlich", status: "published" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    await run(["content.update:pages"], { params: { id }, query: { locale: "en" }, body: { slug: "secret-en", title: "Secret EN", status: "published" } }, instance);
    const res = await run(["content.get:pages"], { params: { id } }, instance);
    expect(boundaryCast<ContentDocument>(res.result, "host")._translations).toEqual({ de: true, en: true });
  });
});

describe("content/default: a fixed filter together with fallback=true is refused", () => {
  it("refuses to build content.get combining a fixed filter with fallback=true", async () => {
    const { instance } = await bootPublish();
    expect(() => run(["content.get:pages?status=published&fallback=true"], { params: { id: "x" } }, instance)).toThrow(/fallback/);
  });

  it("refuses to build content.list combining a fixed filter with fallback=true", async () => {
    const { instance } = await bootPublish();
    expect(() => run(["content.list:pages?status=published&fallback=true"], {}, instance)).toThrow(/fallback/);
  });

  it("refuses with a typed boot error of this module", async () => {
    const { instance } = await bootPublish();
    const steps = module.steps!(instance);
    let caught: unknown;
    try {
      steps.list("pages?status=published&fallback=true");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KestrelBootError);
    expect(caught).toMatchObject({ code: "step-argument", module: "content/default" });
  });

  it("checkBoot reports it as a problem naming the pipeline, the step and the module instead of rejecting", async () => {
    const persistence = defineModule({
      name: "persistence/fake",
      provides: [PERSISTENCE],
      requires: [],
      configSchema: z.object({}).strict(),
      async setup() {
        return createFakePersistence();
      },
    });
    const step = "content.list:pages?status=published&fallback=true";
    const input = {
      config: { modules: [{ use: "./persistence-fake.ts" }, { use: "@michaelthielemann/kestrel-content-default", config: PUBLISH_MODEL }], triggers: [] },
      modules: [persistence, module],
      pipelines: [definePipeline({ name: "listPublished", steps: [step] })],
      logger: silentLogger,
    };
    const check = await checkBoot(input, { setup: "all" });
    expect(check.errors).toEqual([expect.objectContaining({ code: "step-argument", pipeline: "listPublished", step })]);
    expect(check.errors[0]?.reason).toContain('"content/default"');
    expect(check.errors[0]?.reason).toContain(step);
    await expect(bootKestrel(input)).rejects.toThrow(KestrelBootError);
  });

  it("still allows fallback=true alone and a fixed filter alone", async () => {
    const { instance } = await bootPublish();
    const created = await run(["content.create:pages"], { body: { slug: "oeffentlich", title: "Oeffentlich", status: "published" } }, instance);
    const id = boundaryCast<ContentDocument>(created.result, "host").id;
    await expect(run(["content.get:pages?fallback=true"], { params: { id } }, instance)).resolves.toMatchObject({ status: 200 });
    await expect(run(["content.get:pages?status=published"], { params: { id } }, instance)).resolves.toMatchObject({ status: 200 });
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
    eventTriggers: [],
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

describe("content/default: atomicSafe is pinned", () => {
  it("every step is atomic-safe", async () => {
    const { instance } = await boot();
    const describeMap = module.describe!(instance);
    for (const [name, description] of Object.entries(describeMap)) {
      const resolved = typeof description === "function" ? description("x") : description;
      expect(resolved.atomicSafe, `${name}.atomicSafe`).toBe(true);
    }
  });
});
