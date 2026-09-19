import { describe, expect, it } from "vitest";
import { CONTENT, type Content, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { RevisionPage, RevisionSummary } from "@michaelthielemann/kestrel-contracts/revisions";
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
import module, { configSchema } from "./module.ts";

const model: ContentModel = { locales: ["de", "en"], defaultLocale: "de", types: { pages: { kind: "multi", fields: { title: "text", status: "enum" } } } };

const IDENTITY = { id: "u1", claims: { username: "alice" } };

function fakeContent(): Content {
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return { model: () => model, validate: () => ({ ok: true, data: {} }), get: notImplemented, list: notImplemented, create: notImplemented, set: notImplemented, update: notImplemented, remove: notImplemented, removeTranslation: notImplemented };
}

function depsWith(providers: Map<string, unknown>): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (!providers.has(contract.name)) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(providers.get(contract.name), "host");
    },
    find: <T>(contract: Contract<T>): T | undefined => boundaryCast<T | undefined>(providers.get(contract.name), "host"),
    logger: silentLogger,
    root: process.cwd(),
  };
}

async function boot(config: Record<string, unknown> = {}, withContent = true) {
  const db = createFakePersistence();
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  if (withContent) providers.set(CONTENT.name, fakeContent());
  return module.setup(configSchema.parse(config), depsWith(providers));
}

const helpers: Record<string, Step | StepFactory> = {
  "test.identify": async (ctx: Context) => ok({ ...ctx, identity: IDENTITY }),
  "test.seed": async (ctx: Context) => ok({ ...ctx, result: { id: "p1", title: "A", status: "draft" } }),
  "test.save": async (ctx: Context) => ok({ ...ctx, result: { id: "p1", ...ctx.payload } }),
};

function run(steps: string[], input: Record<string, unknown>, instance: unknown): Promise<RunResult> {
  return runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }], steps: helpers, writes: { "test.identify": ["identity"], "test.seed": ["result"], "test.save": ["result"] } });
}

const page = (result: unknown): RevisionPage => boundaryCast<RevisionPage>(result, "json");
const summary = (result: unknown): RevisionSummary => boundaryCast<RevisionSummary>(result, "json");

describe("revisions/default module steps", () => {
  it("records the saved document with the author, status and locale of the run", async () => {
    const instance = await boot();
    expect((await run(["test.identify", "test.seed", "revisions.record:pages"], {}, instance)).status).toBe(200);
    const listed = await run(["revisions.list:pages"], { params: { id: "p1" } }, instance);
    expect(listed.status).toBe(200);
    const [first] = page(listed.result).items;
    expect(first).toMatchObject({ collection: "pages", documentId: "p1", locale: "de", parentId: null, kind: "save", status: "draft", live: false, label: null });
    expect(first?.author).toEqual({ id: "u1", name: "alice" });
    expect(page(listed.result).head).toBe(first?.id);
  });

  it("keeps a separate history per locale", async () => {
    const instance = await boot();
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    await run(["test.seed", "revisions.record:pages"], { query: { locale: "en" } }, instance);
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).total).toBe(1);
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" }, query: { locale: "en" } }, instance)).result).total).toBe(1);
  });

  it("records under * when no content model declares locales", async () => {
    const instance = await boot({}, false);
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    const listed = await run(["revisions.list:pages"], { params: { id: "p1" } }, instance);
    expect(page(listed.result).items[0]?.locale).toBe("*");
  });

  it("reads one revision with its snapshot and answers 404 for an unknown one", async () => {
    const instance = await boot();
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    const [first] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items;
    const read = await run(["revisions.read:pages"], { params: { id: "p1", revisionId: first?.id ?? "" } }, instance);
    expect(read.status).toBe(200);
    expect(boundaryCast<{ snapshot: unknown }>(read.result, "json").snapshot).toEqual({ title: "A", status: "draft" });
    const missing = await run(["revisions.read:pages"], { params: { id: "p1", revisionId: "nope" } }, instance);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("NOT_FOUND");
  });

  it("restore puts the snapshot into the body and the next record branches at the restored revision", async () => {
    const instance = await boot();
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    const [older] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items;
    await run(["test.save", "revisions.record:pages"], { body: { title: "B", status: "draft" }, payload: { title: "B", status: "draft" } }, instance);

    const restored = await run(["revisions.restore:pages", "test.save", "revisions.record:pages"], { params: { id: "p1", revisionId: older?.id ?? "" } }, instance);
    expect(restored.status).toBe(200);
    expect(restored.result).toMatchObject({ id: "p1", title: "A", status: "draft", locale: "de" });

    const listed = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result);
    expect(listed.total).toBe(3);
    expect(listed.items[0]).toMatchObject({ parentId: older?.id, kind: "restore" });
    expect(listed.head).toBe(listed.items[0]?.id);
    expect(listed.items[1]?.kind).toBe("save");
  });

  it("refuses to restore a revision recorded without a snapshot", async () => {
    const instance = await boot({ maxSnapshotBytes: 8 });
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    const [only] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items;
    expect(only?.skipped).toBe(true);
    const restored = await run(["revisions.restore:pages"], { params: { id: "p1", revisionId: only?.id ?? "" } }, instance);
    expect(restored.status).toBe(409);
    expect(restored.code).toBe("CONFLICT");
  });

  it("sets and clears a label and rejects a body the schema does not allow", async () => {
    const instance = await boot();
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    const [only] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items;
    const params = { id: "p1", revisionId: only?.id ?? "" };
    expect(summary((await run(["revisions.label:pages"], { params, body: { label: "launch" } }, instance)).result).label).toBe("launch");
    expect(summary((await run(["revisions.label:pages"], { params, body: { label: null } }, instance)).result).label).toBeNull();
    const invalid = await run(["revisions.label:pages"], { params, body: { label: 5 } }, instance);
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe("VALIDATION");
  });

  it("prune reports what it inspected and removed", async () => {
    const instance = await boot({ keep: 1 });
    for (let i = 0; i < 3; i += 1) await run(["test.seed", "revisions.record:pages"], {}, instance);
    const pruned = await run(["revisions.prune"], {}, instance);
    expect(pruned.status).toBe(200);
    expect(pruned.result).toMatchObject({ inspected: 1, removed: 0 });
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).total).toBe(1);
  });

  it("drops a document's revisions and, for a translation, only that locale's", async () => {
    const instance = await boot();
    await run(["test.seed", "revisions.record:pages"], {}, instance);
    await run(["test.seed", "revisions.record:pages"], { query: { locale: "en" } }, instance);
    expect((await run(["revisions.removeTranslation:pages"], { params: { id: "p1", locale: "en" } }, instance)).status).toBe(200);
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" }, query: { locale: "en" } }, instance)).result).total).toBe(0);
    expect((await run(["revisions.remove:pages"], { params: { id: "p1" } }, instance)).status).toBe(200);
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).total).toBe(0);
  });

  it("rejects a limit above the declared maximum", async () => {
    const instance = await boot({ maxLimit: 5 });
    const listed = await run(["revisions.list:pages"], { params: { id: "p1" }, query: { limit: "50" } }, instance);
    expect(listed.status).toBe(400);
    expect(listed.code).toBe("VALIDATION");
  });
});
