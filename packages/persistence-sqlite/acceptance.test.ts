import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Context, Step } from "@michaelthielemann/kestrel/context";
import { ok } from "@michaelthielemann/kestrel/result";
import { createPersistenceSqlite, type PersistenceSqlite } from "./impl.ts";

function tempFile(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-acceptance-"));
  return { file: join(dir, "t.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function seedDb(): Promise<{ db: PersistenceSqlite; cleanup: () => void }> {
  const { file, cleanup } = tempFile();
  const db = createPersistenceSqlite({ file, acquireTimeoutMs: 15000 });
  await db.ensureCollection("notes", { title: "string" });
  await db.ensureCollection("notes_index", { noteId: "string" });
  await db.ensureCollection("notes_queue", { noteId: "string" });
  return { db, cleanup };
}

function createStep(db: PersistenceSqlite): Step {
  return async (ctx: Context) => {
    const created = await db.createOne<{ id: string; title: string }>("notes", { title: String(ctx.payload.title) });
    if (!created.ok) return ctx.fail(created.error);
    return ok({ ...ctx, result: created.value });
  };
}
function indexStep(db: PersistenceSqlite, fail: boolean): Step {
  return async (ctx: Context) => {
    if (fail) return ctx.fail("TRANSIENT", "index write failed");
    const id = boundaryCast<{ id: string }>(ctx.result, "host").id;
    await db.createOne("notes_index", { noteId: id });
    return ok(ctx);
  };
}
function queueStep(db: PersistenceSqlite): Step {
  return async (ctx: Context) => {
    const id = boundaryCast<{ id: string }>(ctx.result, "host").id;
    await db.createOne("notes_queue", { noteId: id });
    return ok(ctx);
  };
}

describe("a forced failure inside the group stores nothing", () => {
  it("the request fails and none of the three collections gained a row", async () => {
    const { db, cleanup } = await seedDb();
    const pipeline = definePipeline({ name: "createNote", steps: [{ atomic: ["content.create", "index.write", "queue.write"] }] });
    const result = await runPipeline(
      pipeline,
      { trigger: { kind: "http", name: "POST /notes" }, payload: { title: "hello" } },
      {
        logger: silentLogger,
        atomicScope: (info, body) => db.scope(info, body),
        steps: { "content.create": createStep(db), "index.write": indexStep(db, true), "queue.write": queueStep(db) },
        writes: { "content.create": ["result"], "index.write": ["result?"], "queue.write": ["result?"] },
      },
    );
    expect(result.status).toBe(503);
    expect(result.code).toBe("TRANSIENT");
    expect((expectOk(await db.findMany("notes", {}))).total).toBe(0);
    expect((expectOk(await db.findMany("notes_index", {}))).total).toBe(0);
    expect((expectOk(await db.findMany("notes_queue", {}))).total).toBe(0);
    db.close();
    cleanup();
  });

  it("negative: without the group the same forced failure still leaves the note committed", async () => {
    const { db, cleanup } = await seedDb();
    const pipeline = definePipeline({ name: "createNote", steps: ["content.create", "index.write", "queue.write"] });
    const result = await runPipeline(
      pipeline,
      { trigger: { kind: "http", name: "POST /notes" }, payload: { title: "hello" } },
      {
        logger: silentLogger,
        steps: { "content.create": createStep(db), "index.write": indexStep(db, true), "queue.write": queueStep(db) },
        writes: { "content.create": ["result"], "index.write": ["result?"], "queue.write": ["result?"] },
      },
    );
    expect(result.status).toBe(503);
    expect((expectOk(await db.findMany("notes", {}))).total).toBe(1);
    expect((expectOk(await db.findMany("notes_index", {}))).total).toBe(0);
    db.close();
    cleanup();
  });
});

describe("two parallel requests never see a half state", () => {
  it("a second request's group begins only after the first settled, and a concurrent read never sees the half-written row", async () => {
    const { db, cleanup } = await seedDb();
    let releaseA: () => void = () => {};
    const aBlocked = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const order: string[] = [];

    const pipelineA = definePipeline({ name: "createNote", steps: [{ atomic: ["content.create", "latch.wait", "queue.write"] }] });
    const latchStep: Step = async (ctx: Context) => {
      order.push("A-inside-latch");
      await aBlocked;
      order.push("A-after-latch");
      return ok(ctx);
    };
    const runA = runPipeline(
      pipelineA,
      { trigger: { kind: "http", name: "POST /notes" }, payload: { title: "a" } },
      {
        logger: silentLogger,
        atomicScope: (info, body) => db.scope(info, body),
        steps: { "content.create": createStep(db), "latch.wait": latchStep, "queue.write": queueStep(db) },
        writes: { "content.create": ["result"], "latch.wait": ["result?"], "queue.write": ["result?"] },
      },
    );

    await new Promise((r) => setTimeout(r, 20));

    const listPipeline = definePipeline({ name: "listNotes", steps: ["content.list"] });
    const listStep: Step = async (ctx: Context) => ok({ ...ctx, result: expectOk(await db.findMany("notes", {})) });
    const listPromise = runPipeline(
      listPipeline,
      { trigger: { kind: "http", name: "GET /notes" }, payload: {} },
      { logger: silentLogger, steps: { "content.list": listStep }, writes: { "content.list": ["result"] } },
    ).then((res) => {
      order.push("list-resolved");
      return res;
    });

    const pipelineB = definePipeline({ name: "createNote", steps: [{ atomic: ["content.create", "queue.write"] }] });
    const runB = (async () => {
      order.push("B-calling-scope");
      const res = await runPipeline(
        pipelineB,
        { trigger: { kind: "http", name: "POST /notes" }, payload: { title: "b" } },
        {
          logger: silentLogger,
          atomicScope: (info, body) => db.scope(info, body),
          steps: { "content.create": createStep(db), "queue.write": queueStep(db) },
          writes: { "content.create": ["result"], "queue.write": ["result?"] },
        },
      );
      order.push("B-settled");
      return res;
    })();

    await new Promise((r) => setTimeout(r, 20));
    expect(order).not.toContain("B-settled");
    releaseA();

    const [resultA, resultB] = await Promise.all([runA, runB, listPromise]);
    expect(resultA.status).toBe(200);
    expect(resultB.status).toBe(200);

    expect(order.indexOf("A-after-latch")).toBeLessThan(order.indexOf("list-resolved"));
    expect(order.indexOf("A-after-latch")).toBeLessThan(order.indexOf("B-settled"));
    const rows = expectOk(await db.findMany<{ id: string; title: string }>("notes", {}, { sort: { title: "asc" } }));
    expect(rows.items.map((r) => r.title)).toEqual(["a", "b"]);
    db.close();
    cleanup();
  });
});
