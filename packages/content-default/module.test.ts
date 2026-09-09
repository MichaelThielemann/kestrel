import { describe, expect, it } from "vitest";
import type { ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
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
      return providers.get(contract.name) as T;
    },
    find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
  const config = configSchema.parse(MODEL);
  const instance = await module.setup(config, deps);
  return { instance, db };
}

function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
}

describe("content/default module steps", () => {
  it("validate accepts a matching payload", async () => {
    const { instance } = await boot();
    const res = await run(["content.validate:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    expect(res.status).toBe(200);
  });

  it("create stores a document", async () => {
    const { instance } = await boot();
    const res = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    expect(res.status).toBe(200);
    expect((res.result as ContentDocument).slug).toBe("a");
  });

  it("get reads a document by id", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = (created.result as ContentDocument).id;
    const res = await run(["content.get:notes"], { params: { id }, query: { locale: "de" } }, instance);
    expect(res.status).toBe(200);
    expect((res.result as ContentDocument).slug).toBe("a");
  });

  it("list pages through the documents of a type", async () => {
    const { instance } = await boot();
    await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const res = await run(["content.list:notes"], { query: { limit: "10", offset: "0", sort: "slug" } }, instance);
    expect(res.status).toBe(200);
    expect((res.result as { total: number }).total).toBe(1);
  });

  it("update changes a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = (created.result as ContentDocument).id;
    const res = await run(["content.update:notes"], { params: { id }, body: { status: "published" } }, instance);
    expect(res.status).toBe(200);
    expect((res.result as ContentDocument).status).toBe("published");
  });

  it("removeTranslation drops one locale of a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = (created.result as ContentDocument).id;
    await run(["content.update:notes"], { params: { id }, body: { title: "A-en" }, query: { locale: "en" } }, instance);
    const res = await run(["content.removeTranslation:notes"], { params: { id }, query: { locale: "en" } }, instance);
    expect(res.status).toBe(200);
  });

  it("remove deletes a document", async () => {
    const { instance } = await boot();
    const created = await run(["content.create:notes"], { body: { slug: "a", title: "A", status: "draft" } }, instance);
    const id = (created.result as ContentDocument).id;
    const res = await run(["content.remove:notes"], { params: { id } }, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ ok: true });
  });

  it("set replaces the settings singleton", async () => {
    const { instance } = await boot();
    const res = await run(["content.set:settings"], { body: { title: "My Site" } }, instance);
    expect(res.status).toBe(200);
    expect((res.result as ContentDocument).title).toBe("My Site");
  });

  it("rejects a non-integer limit with 400 VALIDATION from the query schema", async () => {
    const { instance } = await boot();
    const res = await run(["content.list:notes"], { query: { limit: "abc" } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
    expect(res.details?.problems).toEqual([{ path: "$.limit", message: "expected integer, got string" }]);
  });
});
