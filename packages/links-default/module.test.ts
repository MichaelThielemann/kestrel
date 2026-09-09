import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Content, ContentDocument, ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import type { Context, Step, StepFactory } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import type { RunResult } from "@michaelthielemann/kestrel/runner";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import module, { configSchema } from "./module.ts";

const model: ContentModel = { types: { pages: { kind: "multi", fields: { title: "text", body: "json" } } } };

function fakeContent(): Content {
  const docs = new Map<string, Record<string, unknown>>();
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return {
    model: () => model,
    validate: () => ({ ok: true, data: {} }),
    async get(type, id) {
      const row = id === undefined ? undefined : docs.get(id);
      return ok(row && row.type === type ? (row as ContentDocument) : null);
    },
    async list(type) {
      const all = [...docs.values()].filter((r) => r.type === type) as ContentDocument[];
      return ok({ items: all, total: all.length });
    },
    async create(type, data) {
      const id = randomUUID();
      const row = { id, type, createdAt: 1, updatedAt: 1, ...data };
      docs.set(id, row);
      return ok(row as ContentDocument);
    },
    set: notImplemented,
    update: notImplemented,
    remove: notImplemented,
    removeTranslation: notImplemented,
  };
}

async function boot() {
  const db = createFakePersistence();
  const content = fakeContent();
  const providers = new Map<string, unknown>([[CONTENT.name, content], [PERSISTENCE.name, db]]);
  const deps: Deps = {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return providers.get(contract.name) as T;
    },
    find: <T>(contract: Contract<T>): T | undefined => providers.get(contract.name) as T | undefined,
    logger: silentLogger,
    root: process.cwd(),
  };
  const config = configSchema.parse({});
  const instance = await module.setup(config, deps);
  return { instance, content };
}

const seed = (result: unknown): Record<string, Step | StepFactory> => ({ "test.seed": async (ctx: Context) => ok({ ...ctx, result }) });

function run(steps: string[], input: Record<string, unknown>, instance: unknown, extraSteps: Record<string, Step | StepFactory> = {}): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }], steps: extraSteps });
}

describe("links/default module steps", () => {
  it("extract indexes the links of a created document", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", body: { text: "see https://example.com/x" } }));
    const res = await run(["test.seed", "links.extract:pages"], {}, instance, seed({ id: page.id }));
    expect(res.status).toBe(200);
  });

  it("unextract drops the indexed links of a document", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", body: { text: "see https://example.com/x" } }));
    await run(["test.seed", "links.extract:pages"], {}, instance, seed({ id: page.id }));
    const res = await run(["links.unextract:pages"], { params: { id: page.id } }, instance);
    expect(res.status).toBe(200);
  });

  it("check answers a summary when nothing is due", async () => {
    const { instance } = await boot();
    const res = await run(["links.check"], {}, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ urls: 0, checked: 0, broken: 0, skipped: 0 });
  });

  it("report lists broken links for a type", async () => {
    const { instance } = await boot();
    const res = await run(["links.report"], { query: { type: "pages" } }, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual([]);
  });

  it("rebuild recomputes the link index", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", body: { text: "see https://example.com/x" } }));
    await run(["test.seed", "links.extract:pages"], {}, instance, seed({ id: page.id }));
    const res = await run(["links.rebuild"], {}, instance);
    expect(res.status).toBe(200);
  });

  it("rejects a non-string type query with 400 VALIDATION from the query schema", async () => {
    const { instance } = await boot();
    const res = await run(["links.report"], { query: { type: 5 } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });
});
