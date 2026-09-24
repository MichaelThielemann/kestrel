import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { boot, type Kestrel } from "@michaelthielemann/kestrel";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Context } from "@michaelthielemann/kestrel/context";
import eventsDirect from "@michaelthielemann/kestrel-events-direct";
import eventsInmemory from "@michaelthielemann/kestrel-events-inmemory";
import eventsQueue from "@michaelthielemann/kestrel-events-queue";
import persistenceSqlite from "@michaelthielemann/kestrel-persistence-sqlite";

const notes = defineModule({
  name: "notes/local",
  provides: [],
  requires: [],
  configSchema: z.object({}).strict(),
  async setup() {
    return {};
  },
  steps: () => ({
    create: async (ctx: Context): Promise<Result<Context, never>> => ok({ ...ctx, result: { id: "n1" } }),
    onCreated: async (ctx: Context): Promise<Result<Context, never>> => ok(ctx),
  }),
  describe: () => ({
    create: { summary: "create a note", reads: [], writes: ["result"], output: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    onCreated: { summary: "react to note.created", reads: [], writes: [] },
  }),
});

const createNote = definePipeline({ name: "createNote", steps: ["notes.create", "events.emit:note.created"] });
const onNoteCreated = definePipeline({ name: "onNoteCreated", steps: ["notes.onCreated"] });

let kestrel: Kestrel | undefined;
afterEach(async () => {
  await kestrel?.stop();
  kestrel = undefined;
});

describe("the queue offer's switch boots, on both sides", () => {
  it("boots on events-direct (before the switch)", async () => {
    kestrel = await boot({
      config: {
        modules: [{ use: "events-inmemory", config: {} }, { use: "events-direct", config: {} }, { use: "persistence-sqlite", config: { file: ":memory:", acquireTimeoutMs: 15000 } }, { use: "notes", config: {} }],
        triggers: [{ http: "POST /notes", pipeline: "createNote" }, { event: "note.created", pipeline: "onNoteCreated" }],
        http: null,
      },
      modules: [eventsInmemory, eventsDirect, persistenceSqlite, notes],
      pipelines: [createNote, onNoteCreated],
      logger: silentLogger,
    });
    const res = await kestrel.run("createNote", { trigger: { kind: "http", name: "t" }, payload: {} });
    expect(res.status).toBe(200);
  });

  it("boots on events-queue with relayPipelines (the switch the codemod produces)", async () => {
    kestrel = await boot({
      config: {
        modules: [
          { use: "events-inmemory", config: {} },
          { use: "events-queue", config: { relayPipelines: ["onNoteCreated"] } },
          { use: "persistence-sqlite", config: { file: ":memory:", acquireTimeoutMs: 15000 } },
          { use: "notes", config: {} },
        ],
        triggers: [{ http: "POST /notes", pipeline: "createNote" }, { event: "note.created", pipeline: "onNoteCreated" }],
        http: null,
      },
      modules: [eventsInmemory, eventsQueue, persistenceSqlite, notes],
      pipelines: [createNote, onNoteCreated],
      logger: silentLogger,
    });
    await kestrel.start();
    const res = await kestrel.run("createNote", { trigger: { kind: "http", name: "t" }, payload: {} });
    expect(res.status).toBe(200);
  });
});
