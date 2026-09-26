import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Content, ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { err, failure, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { createFakePersistence } from "@michaelthielemann/kestrel-contracts/testing/fakePersistence";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boot, KestrelBootError, type ModuleDefinition } from "@michaelthielemann/kestrel";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { createRedirects, type Move } from "./impl.ts";
import module from "./module.ts";

const config = { type: "redirects", field: "rules", prefix: "site/", key: "redirects.json" };

function fakeContent(rules: unknown = []): Content {
  const doc: ContentDocument = { id: "redirects", createdAt: 1, updatedAt: 1, rules };
  const notImplemented = () => Promise.reject(new Error("not needed"));
  return { model: () => ({ types: {} }), validate: () => ({ ok: true, data: {} }), async get() { return ok(doc); }, list: notImplemented, create: notImplemented, set: notImplemented, update: notImplemented, remove: notImplemented, removeTranslation: notImplemented };
}

function fakeBlobs(): Blobstore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(k, data) {
      blobs.set(k, data);
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k) ?? null);
    },
    async remove(k) {
      blobs.delete(k);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list() {
      return ok([]);
    },
  };
}

const quiet = { step() {}, info() {}, error() {} };

function move(partial: Partial<Move> & Pick<Move, "type" | "id" | "locale" | "seq">): Move {
  return { from: null, to: null, ...partial };
}

async function domain(rules: unknown = []) {
  return createRedirects(config, { content: fakeContent(rules), blobs: fakeBlobs(), db: createFakePersistence(), logger: quiet });
}

describe("automatic redirects: recording moves", () => {
  it("a rename creates a redirect from the old to the new path", async () => {
    const r = await domain();
    expect(expectOk(await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]))).toEqual({ recorded: 1 });
    expect(expectOk(await r.lookup("/a"))).toEqual({ to: "/b", status: 301 });
  });

  it("a second rename answers with the newest path from both the first and the second old path, without chaining", async () => {
    const r = await domain();
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/b", to: "/c", seq: 2 })]);
    expect(expectOk(await r.lookup("/a"))).toEqual({ to: "/c", status: 301 });
    expect(expectOk(await r.lookup("/b"))).toEqual({ to: "/c", status: 301 });
  });

  it("ends in the same state when the moves are delivered in reverse order", async () => {
    const forward = await domain();
    await forward.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    await forward.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/b", to: "/c", seq: 2 })]);

    const reversed = await domain();
    await reversed.recordMoves([
      move({ type: "page", id: "d1", locale: "de", from: "/b", to: "/c", seq: 2 }),
      move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 }),
    ]);

    expect(expectOk(await reversed.lookup("/a"))).toEqual(expectOk(await forward.lookup("/a")));
    expect(expectOk(await reversed.lookup("/b"))).toEqual(expectOk(await forward.lookup("/b")));
  });

  it("a replay of an old move after another document took its from path creates nothing", async () => {
    const r = await domain();
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    await r.recordMoves([move({ type: "page", id: "d2", locale: "de", from: null, to: "/a", seq: 2 })]);
    expect(expectOk(await r.lookup("/a"))).toBeNull();

    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    expect(expectOk(await r.lookup("/a"))).toBeNull();
  });

  it("a swap inside one run leaves both paths unredirected", async () => {
    const r = await domain();
    await r.recordMoves([
      move({ type: "page", id: "a", locale: "de", from: "/a", to: "/b", seq: 5 }),
      move({ type: "page", id: "b", locale: "de", from: "/b", to: "/a", seq: 5 }),
    ]);
    expect(expectOk(await r.lookup("/a"))).toBeNull();
    expect(expectOk(await r.lookup("/b"))).toBeNull();
  });

  it("to: null ends redirects to that document", async () => {
    const r = await domain();
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    expect(expectOk(await r.lookup("/a"))).toEqual({ to: "/b", status: 301 });
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/b", to: null, seq: 2 })]);
    expect(expectOk(await r.lookup("/a"))).toBeNull();
    expect(expectOk(await r.lookup("/b"))).toBeNull();
  });

  it("the same event twice changes nothing", async () => {
    const r = await domain();
    const moves = [move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })];
    await r.recordMoves(moves);
    const before = expectOk(await r.listAuto());
    await r.recordMoves(moves);
    expect(expectOk(await r.listAuto())).toEqual(before);
  });
});

describe("automatic redirects: admin removal", () => {
  it("a removed automatic redirect stays removed when the move that created it is replayed", async () => {
    const r = await domain();
    const moves = [move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })];
    await r.recordMoves(moves);
    expect(expectOk(await r.removeAuto("a"))).toBeUndefined();
    expect(expectOk(await r.lookup("/a"))).toBeNull();

    await r.recordMoves(moves);
    expect(expectOk(await r.lookup("/a"))).toBeNull();
  });

  it("answers NOT_FOUND for a path with no automatic redirect", async () => {
    const r = await domain();
    const error = expectErr(await r.removeAuto("nope"), "NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("listAuto sorts by from", async () => {
    const r = await domain();
    await r.recordMoves([
      move({ type: "page", id: "d1", locale: "de", from: "/z", to: "/z2", seq: 1 }),
      move({ type: "page", id: "d2", locale: "de", from: "/a", to: "/a2", seq: 1 }),
    ]);
    expect(expectOk(await r.listAuto()).map((a) => a.from)).toEqual(["/a", "/z"]);
  });
});

describe("automatic redirects: concurrent deliveries", () => {
  for (const order of ["older first", "newer first"] as const) {
    it(`two deliveries recorded at the same time end with the newer state (${order})`, async () => {
      const r = await domain();
      await r.recordMoves([move({ type: "page", id: "b", locale: "de", from: null, to: "/b", seq: 1 })]);
      const older = [move({ type: "page", id: "b", locale: "de", from: "/b", to: "/c", seq: 5 })];
      const newer = [move({ type: "page", id: "a", locale: "de", from: null, to: "/b", seq: 6 })];
      const results = await Promise.all(order === "older first" ? [r.recordMoves(older), r.recordMoves(newer)] : [r.recordMoves(newer), r.recordMoves(older)]);
      for (const result of results) expectOk(result);
      expect(expectOk(await r.lookup("/b"))).toBeNull();
      expect(expectOk(await r.lookup("/c"))).toBeNull();
      expect(expectOk(await r.listAuto())).toEqual([]);
    });
  }
});

describe("automatic redirects: editor precedence", () => {
  it("an automatic redirect into a path an editor rule redirects back answers nothing instead of looping", async () => {
    const r = await createRedirects(config, { content: fakeContent([{ from: "/b", to: "/a" }]), blobs: fakeBlobs(), db: createFakePersistence(), logger: quiet });
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    expect(expectOk(await r.lookup("/b"))).toEqual({ to: "/a", status: 301 });
    expect(expectOk(await r.lookup("/a"))).toBeNull();
  });

  it("an old path with a trailing slash redirects too", async () => {
    const r = await domain();
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/alt", to: "/neu", seq: 1 })]);
    expect(expectOk(await r.lookup("/alt/"))).toEqual({ to: "/neu", status: 301 });
  });

  it("an editor rule wins over an automatic one, and redirects.json lists editor rules first", async () => {
    const r = await createRedirects(config, { content: fakeContent([{ from: "/a", to: "/edited" }]), blobs: fakeBlobs(), db: createFakePersistence(), logger: quiet });
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    expect(expectOk(await r.lookup("/a"))).toEqual({ to: "/edited", status: 301 });

    const rendered = expectOk(await r.render());
    expect(rendered[0]?.target).toBe("/edited");
    expect(rendered.some((rule) => rule.target === "/b")).toBe(true);
  });

  it("skips an automatic redirect whose target path an editor rule matches", async () => {
    const r = await createRedirects(config, { content: fakeContent([{ from: "/b", to: "/final" }]), blobs: fakeBlobs(), db: createFakePersistence(), logger: quiet });
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    const rendered = expectOk(await r.render());
    expect(rendered.some((rule) => rule.target === "/b")).toBe(false);
  });

  it("validate reports an editor rule that redirects into an existing automatic redirect", async () => {
    const r = await domain();
    await r.recordMoves([move({ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 })]);
    await expect(r.validate([{ from: "/x", to: "/a" }])).rejects.toThrow(/^Row 1:/);
  });
});

describe("redirects.recordMoves step", () => {
  async function stepsWith(persistence = createFakePersistence()) {
    const deps: Deps = {
      get<T>(contract: Contract<T>): T {
        if (contract.name === CONTENT.name) return boundaryCast<T>(fakeContent(), "host");
        if (contract.name === PERSISTENCE.name) return boundaryCast<T>(persistence, "host");
        return boundaryCast<T>(fakeBlobs(), "host");
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    };
    const instance = await module.setup(module.configSchema.parse({ prefix: "site/" }), deps);
    return module.steps!(instance);
  }

  it("rejects a malformed payload with VALIDATION", async () => {
    const steps = await stepsWith();
    const ctx = createContext({ trigger: { kind: "event", name: "site.pathsMoved" }, payload: { moves: [{ type: "page" }] } });
    const error = expectErr(await steps.recordMoves(ctx), "VALIDATION");
    expect(error.status).toBe(400);
  });

  it("accepts the empty locale of a model without locales", async () => {
    const steps = await stepsWith();
    const ctx = createContext({ trigger: { kind: "event", name: "site.pathsMoved" }, payload: { moves: [{ type: "page", id: "d1", locale: "", from: "/a", to: "/b", seq: 1 }] } });
    expectOk(await steps.recordMoves(ctx));
  });

  it("reports how many moves were recorded", async () => {
    const steps = await stepsWith();
    const ctx = createContext({ trigger: { kind: "event", name: "site.pathsMoved" }, payload: { moves: [{ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 }] } });
    const done = expectOk(await steps.recordMoves(ctx));
    expect(done.result).toEqual({ autoRedirects: { recorded: 1 } });
  });

  it("recordMoves, listAuto and removeAuto run through the runner with their declared writes", async () => {
    const persistence = createFakePersistence();
    const deps: Deps = {
      get<T>(contract: Contract<T>): T {
        if (contract.name === CONTENT.name) return boundaryCast<T>(fakeContent(), "host");
        if (contract.name === PERSISTENCE.name) return boundaryCast<T>(persistence, "host");
        return boundaryCast<T>(fakeBlobs(), "host");
      },
      find: () => undefined,
      logger: silentLogger,
      root: process.cwd(),
      eventTriggers: [],
    };
    const instance = await module.setup(module.configSchema.parse({ prefix: "site/" }), deps);
    const run = (steps: string[], input: Record<string, unknown>) => runPipeline(definePipeline({ name: "test", steps }), input, { modules: [{ module, instance }] });
    const recorded = await run(["redirects.recordMoves", "redirects.export"], { trigger: { kind: "event", name: "site.pathsMoved" }, payload: { moves: [{ type: "page", id: "d1", locale: "de", from: "/a", to: "/b", seq: 1 }] } });
    expect(recorded.status).toBe(200);
    expect(recorded.result).toMatchObject({ autoRedirects: { recorded: 1 }, redirects: { rules: 1 } });
    expect((await run(["redirects.listAuto"], {})).result).toEqual([{ from: "/a", to: "/b", type: "page", docId: "d1", locale: "de", seq: 1 }]);
    expect((await run(["redirects.removeAuto"], { params: { path: "a" } })).status).toBe(200);
  });

  it("removeAuto reads params.path without a leading slash and answers NOT_FOUND when nothing is there", async () => {
    const steps = await stepsWith();
    const ctx = createContext({ trigger: { kind: "http", name: "DELETE /admin/redirects/auto/*path" }, params: { path: "nope" } });
    const error = expectErr(await steps.removeAuto(ctx), "NOT_FOUND");
    expect(error.status).toBe(404);
  });
});

describe("redirects/default at boot", () => {
  const empty = z.object({}).strict();
  const contentModule: ModuleDefinition = { name: "content/default", provides: [CONTENT], requires: [], configSchema: empty, setup: async () => fakeContent() };
  const blobstoreModule: ModuleDefinition = { name: "blobstore/memory", provides: [BLOBSTORE], requires: [], configSchema: empty, setup: async () => fakeBlobs() };
  const persistenceModule: ModuleDefinition = { name: "persistence/memory", provides: [PERSISTENCE], requires: [], configSchema: empty, setup: async () => createFakePersistence() };
  const redirects = (cfg: Record<string, unknown> = {}) => ({ use: "@michaelthielemann/kestrel-redirects-default", config: cfg });

  it("fails without a persistence@1 provider, naming the contract", async () => {
    const booting = boot({ config: { modules: [{ use: "./content-default" }, { use: "./blobstore-memory" }, redirects()], triggers: [] }, modules: [contentModule, blobstoreModule, module], pipelines: [], logger: silentLogger });
    await expect(booting).rejects.toThrow(new KestrelBootError("redirects/default", 'requires "persistence@1" but no active module provides it', "missing-provider"));
    await expect(booting).rejects.toMatchObject({ code: "missing-provider" });
  });

  it("boots with a persistence@1 provider and requires it", async () => {
    expect(module.requires.map((c) => c.name)).toContain("persistence@1");
    const kestrel = await boot({ config: { modules: [{ use: "./content-default" }, { use: "./blobstore-memory" }, { use: "./persistence-memory" }, redirects()], triggers: [], http: null }, modules: [contentModule, blobstoreModule, persistenceModule, module], pipelines: [], logger: silentLogger });
    expect(kestrel.describe().modules.find((m) => m.name === "redirects/default")?.requires).toEqual(["content@1", "blobstore@1", "persistence@1"]);
    await kestrel.stop();
  });
});
