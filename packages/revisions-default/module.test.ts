import { describe, expect, it } from "vitest";
import contentModule from "@michaelthielemann/kestrel-content-default";
import { createContentDefault } from "@michaelthielemann/kestrel-content-default/impl";
import { CONTENT, type Content, type ContentModel, type TypeDefinition } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE, type Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
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

function fakeContent(types: ContentModel["types"] = model.types): Content {
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return { model: () => ({ ...model, types }), validate: () => ({ ok: true, data: {} }), get: notImplemented, list: notImplemented, create: notImplemented, set: notImplemented, update: notImplemented, remove: notImplemented, removeTranslation: notImplemented };
}

const pagesWith = (fields: TypeDefinition["fields"]): ContentModel["types"] => ({ pages: { kind: "multi", fields } });

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

async function bootOn(db: Persistence, config: Record<string, unknown> = {}, content: Content | null = fakeContent()) {
  const providers = new Map<string, unknown>([[PERSISTENCE.name, db]]);
  if (content !== null) providers.set(CONTENT.name, content);
  return module.setup(configSchema.parse(config), depsWith(providers));
}

async function boot(config: Record<string, unknown> = {}, content: Content | null = fakeContent()) {
  return bootOn(createFakePersistence(), config, content);
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
    const instance = await boot({}, null);
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

  it("drops the fields the model lost, names the ones it gained and reports both into the result", async () => {
    const db = createFakePersistence();
    const before = await bootOn(db, {}, fakeContent(pagesWith({ title: "text", teaser: "text", status: "enum" })));
    const fields = { title: "A", teaser: "T", status: "draft" };
    await run(["test.save", "revisions.record:pages"], { body: fields, payload: fields }, before);
    const [only] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, before)).result).items;
    const params = { id: "p1", revisionId: only?.id ?? "" };

    const after = await bootOn(db, {}, fakeContent(pagesWith({ title: "text", status: "enum", author: "text" })));
    const restored = await run(["revisions.restore:pages", "test.save", "revisions.reportRestore"], { params }, after);
    expect(restored.status).toBe(200);
    expect(restored.result).toMatchObject({ id: "p1", title: "A", status: "draft", restore: { revisionId: only?.id, dropped: ["teaser"], missing: ["author"] } });
    expect(restored.result).not.toHaveProperty("teaser");
  });

  it("read reports the same analysis next to the snapshot, so a UI can warn before restoring", async () => {
    const db = createFakePersistence();
    const before = await bootOn(db, {}, fakeContent(pagesWith({ title: "text", teaser: "text", status: "enum" })));
    const fields = { title: "A", teaser: "T", status: "draft" };
    await run(["test.save", "revisions.record:pages"], { body: fields, payload: fields }, before);
    const [only] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, before)).result).items;

    const after = await bootOn(db, {}, fakeContent(pagesWith({ title: "text", status: "enum", author: "text" })));
    const read = await run(["revisions.read:pages"], { params: { id: "p1", revisionId: only?.id ?? "" } }, after);
    expect(read.result).toMatchObject({ snapshot: fields, restore: { revisionId: only?.id, dropped: ["teaser"], missing: ["author"] } });
  });

  it("hands the snapshot over untouched and reports nothing when no content model is known", async () => {
    const instance = await boot({}, null);
    const fields = { title: "A", teaser: "T", status: "draft" };
    await run(["test.save", "revisions.record:pages"], { body: fields, payload: fields }, instance);
    const [only] = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items;
    const params = { id: "p1", revisionId: only?.id ?? "" };

    const restored = await run(["revisions.restore:pages", "test.save", "revisions.reportRestore"], { params }, instance);
    expect(restored.result).toMatchObject({ teaser: "T" });
    expect(restored.result).not.toHaveProperty("restore");
    expect((await run(["revisions.read:pages"], { params }, instance)).result).not.toHaveProperty("restore");
  });

  it("reports nothing for a collection the content model does not describe", async () => {
    const instance = await boot({}, fakeContent(pagesWith({ title: "text" })));
    await run(["test.seed", "revisions.record:posts"], {}, instance);
    const [only] = page((await run(["revisions.list:posts"], { params: { id: "p1" } }, instance)).result).items;
    const restored = await run(["revisions.restore:posts", "test.save", "revisions.reportRestore"], { params: { id: "p1", revisionId: only?.id ?? "" } }, instance);
    expect(restored.result).toMatchObject({ status: "draft" });
    expect(restored.result).not.toHaveProperty("restore");
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

  it("reassignAuthor moves a history to the user the event payload names", async () => {
    const instance = await boot();
    await run(["test.identify", "test.seed", "revisions.record:pages"], {}, instance);
    const reassigned = await run(["revisions.reassignAuthor"], { payload: { id: "u1", result: { ok: true, reassignTo: { id: "u2", name: "bob" } } } }, instance);
    expect(reassigned.status).toBe(200);
    expect(reassigned.result).toEqual({ from: "u1", to: { id: "u2", name: "bob" }, revisions: 1 });
    const listed = page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result);
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.author).toEqual({ id: "u2", name: "bob" });
  });

  it("reassignAuthor anonymises when the payload names no target, and repeats without effect", async () => {
    const instance = await boot();
    await run(["test.identify", "test.seed", "revisions.record:pages"], {}, instance);
    const first = await run(["revisions.reassignAuthor"], { params: { id: "u1" }, payload: {} }, instance);
    expect(first.result).toEqual({ from: "u1", to: null, revisions: 1 });
    const again = await run(["revisions.reassignAuthor"], { params: { id: "u1" }, payload: {} }, instance);
    expect(again.status).toBe(200);
    expect(again.result).toEqual({ from: "u1", to: null, revisions: 0 });
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items[0]?.author).toEqual({ id: null, name: null });
  });

  it("reassignAuthor rejects a target that is not { id, name }, the former author again, and a missing id", async () => {
    const instance = await boot();
    await run(["test.identify", "test.seed", "revisions.record:pages"], {}, instance);
    const wrongShape = await run(["revisions.reassignAuthor"], { params: { id: "u1" }, payload: { reassignTo: "u2" } }, instance);
    expect(wrongShape).toMatchObject({ status: 400, code: "VALIDATION" });
    const itself = await run(["revisions.reassignAuthor"], { params: { id: "u1" }, payload: { reassignTo: { id: "u1", name: "alice" } } }, instance);
    expect(itself).toMatchObject({ status: 400, code: "VALIDATION" });
    const noId = await run(["revisions.reassignAuthor"], { payload: {} }, instance);
    expect(noId).toMatchObject({ status: 400, code: "VALIDATION" });
    expect(page((await run(["revisions.list:pages"], { params: { id: "p1" } }, instance)).result).items[0]?.author).toEqual({ id: "u1", name: "alice" });
  });

  it("rejects a limit above the declared maximum", async () => {
    const instance = await boot({ maxLimit: 5 });
    const listed = await run(["revisions.list:pages"], { params: { id: "p1" }, query: { limit: "50" } }, instance);
    expect(listed.status).toBe(400);
    expect(listed.code).toBe("VALIDATION");
  });
});

describe("revisions/default restore against the real content/default", () => {
  async function wire(db: Persistence, fields: TypeDefinition["fields"]) {
    const content = await createContentDefault({ types: pagesWith(fields) }, db);
    const revisions = await bootOn(db, {}, content);
    return (steps: string[], input: Record<string, unknown>): Promise<RunResult> =>
      runPipeline(definePipeline({ name: "test", steps }), input, {
        modules: [
          { module, instance: revisions },
          { module: contentModule, instance: { ...content, maxLimit: 200 } },
        ],
      });
  }

  const document = (result: unknown): Record<string, unknown> => boundaryCast<Record<string, unknown>>(result, "json");

  it("restores a snapshot the model has outgrown, and the content update takes the reduced body", async () => {
    const db = createFakePersistence();
    const before = await wire(db, { title: "text", teaser: "text", status: "text" });
    const fields = { title: "A", teaser: "T", status: "draft" };
    const created = await before(["content.create:pages", "revisions.record:pages"], { body: fields, payload: fields });
    expect(created.status).toBe(200);
    const id = String(document(created.result).id);
    const revisionId = page((await before(["revisions.list:pages"], { params: { id } })).result).items[0]?.id ?? "";

    const after = await wire(db, { title: "text", status: "text", author: "text" });
    const edited = { title: "B", status: "published", author: "Bob" };
    expect((await after(["content.update:pages"], { params: { id }, body: edited, payload: edited })).status).toBe(200);
    const rejected = await after(["content.update:pages"], { params: { id }, body: { teaser: "T" }, payload: { teaser: "T" } });
    expect(rejected.status).toBe(400);
    expect(rejected.error).toContain("teaser");

    const restored = await after(["revisions.restore:pages", "content.update:pages", "revisions.record:pages", "revisions.reportRestore"], { params: { id, revisionId } });
    expect(restored.status).toBe(200);
    expect(restored.result).toMatchObject({ id, title: "A", status: "draft", author: "Bob", restore: { revisionId, dropped: ["teaser"], missing: ["author"] } });
    expect(document(restored.result)).not.toHaveProperty("teaser");

    const listed = page((await after(["revisions.list:pages"], { params: { id } })).result);
    expect(listed.items[0]).toMatchObject({ kind: "restore", parentId: revisionId });
  });
});
