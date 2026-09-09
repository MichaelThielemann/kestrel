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

const model: ContentModel = { types: { pages: { kind: "multi", fields: { title: "text", hero: { type: "ref", to: "media" } } } } };

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
  await db.ensureCollection("media_items", { filename: "string" });
  await db.createOne("media_items", { id: "m1", filename: "a.png" });
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
  const config = configSchema.parse({ targets: { media: { collection: "media_items" }, pages: { content: "pages" } } });
  const instance = await module.setup(config, deps);
  return { instance, content, db };
}

const seed = (result: unknown): Record<string, Step | StepFactory> => ({ "test.seed": async (ctx: Context) => ok({ ...ctx, result }) });

function run(steps: string[], input: Record<string, unknown>, instance: unknown, extraSteps: Record<string, Step | StepFactory> = {}): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }], steps: extraSteps });
}

describe("references/default module steps", () => {
  it("check passes when the referenced id exists and fails with DANGLING_REF otherwise", async () => {
    const { instance } = await boot();
    const good = await run(["references.check:pages"], { body: { hero: "m1" } }, instance);
    expect(good.status).toBe(200);
    const bad = await run(["references.check:pages"], { body: { hero: "nope" } }, instance);
    expect(bad.status).toBe(400);
    expect(bad.code).toBe("DANGLING_REF");
  });

  it("index records the references of a document, referrers finds them", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", hero: "m1" }));
    const indexed = await run(["test.seed", "references.index:pages"], {}, instance, seed({ id: page.id }));
    expect(indexed.status).toBe(200);
    const referrers = await run(["references.referrers:media"], { params: { id: "m1" } }, instance);
    expect(referrers.status).toBe(200);
    expect(referrers.result).toEqual([{ type: "pages", field: "hero", id: page.id, via: "field" }]);
  });

  it("referrersMany reports referrers per id from the query", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", hero: "m1" }));
    await run(["test.seed", "references.index:pages"], {}, instance, seed({ id: page.id }));
    const res = await run(["references.referrersMany:media"], { query: { ids: "m1" } }, instance);
    expect(res.status).toBe(200);
    expect(res.result).toEqual({ m1: [{ type: "pages", field: "hero", id: page.id, via: "field" }] });
  });

  it("guard refuses while referenced; unindex then allows removal", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", hero: "m1" }));
    await run(["test.seed", "references.index:pages"], {}, instance, seed({ id: page.id }));
    const blocked = await run(["references.guard:media"], { params: { id: "m1" } }, instance);
    expect(blocked.status).toBe(409);
    expect(blocked.code).toBe("CONFLICT");
    const unindexed = await run(["references.unindex:pages"], { params: { id: page.id } }, instance);
    expect(unindexed.status).toBe(200);
    const allowed = await run(["references.guard:media"], { params: { id: "m1" } }, instance);
    expect(allowed.status).toBe(200);
  });

  it("guardAll refuses while any of result.ids is referenced", async () => {
    const { instance, content } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", hero: "m1" }));
    await run(["test.seed", "references.index:pages"], {}, instance, seed({ id: page.id }));
    const res = await run(["test.seed", "references.guardAll:media"], {}, instance, seed({ ids: ["m1"] }));
    expect(res.status).toBe(409);
    expect(res.code).toBe("CONFLICT");
  });

  it("scan and rebuild recompute the index, report lists broken references", async () => {
    const { instance, content, db } = await boot();
    const page = expectOk(await content.create("pages", { title: "A", hero: "m1" }));
    await run(["test.seed", "references.index:pages"], {}, instance, seed({ id: page.id }));
    await db.deleteMany("media_items", { id: "m1" });

    const scanned = await run(["references.scan"], {}, instance);
    expect(scanned.status).toBe(200);
    expect(scanned.result).toEqual({ checked: 1, broken: 1 });

    const reported = await run(["references.report"], { query: { target: "media" } }, instance);
    expect(reported.status).toBe(200);
    expect((reported.result as unknown[]).length).toBe(1);

    const rebuilt = await run(["references.rebuild"], {}, instance);
    expect(rebuilt.status).toBe(200);
  });

  it("rejects a non-string ids query with 400 VALIDATION from the query schema", async () => {
    const { instance } = await boot();
    const res = await run(["references.referrersMany:media"], { query: { ids: 5 } }, instance);
    expect(res.status).toBe(400);
    expect(res.code).toBe("VALIDATION");
  });
});
