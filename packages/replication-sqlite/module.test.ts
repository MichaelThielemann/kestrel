import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { Replication } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function fakeBlobs(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(k, data, options) {
      blobs.set(k, { data: new Uint8Array(data), contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(k) {
      return ok(blobs.get(k)?.data ?? null);
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
    async list(p) {
      return ok([...blobs].filter(([k]) => k.startsWith(p)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function moduleDeps(blobs: Blobstore, root: string, bootStartedAt?: number): Deps {
  return {
    ...(bootStartedAt === undefined ? {} : { bootStartedAt }),
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return boundaryCast<T>(blobs, "host");
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
    eventTriggers: [],
  };
}

const dirs: string[] = [];
const open: Replication[] = [];
afterEach(() => {
  for (const r of open.splice(0)) r.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(): Promise<{ instance: Replication; blobs: ReturnType<typeof fakeBlobs> }> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-mod-"));
  dirs.push(dir);
  const file = join(dir, "live.db");
  const app = new DatabaseSync(file);
  app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  app.prepare("INSERT INTO t (v) VALUES ('x')").run();
  app.close();
  const blobs = fakeBlobs();
  const config = configSchema.parse({ file, restoreOnStart: false });
  const instance = boundaryCast<Replication>(await module.setup(config, moduleDeps(blobs, dir)), "host");
  open.push(instance);
  return { instance, blobs };
}

describe("replication/sqlite module via runPipeline", () => {
  it("sync ships the current state as a first snapshot", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "sync", steps: ["replication.sync"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ generation: expect.any(String) as unknown });
  });

  it("snapshot starts a new generation", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "snapshot", steps: ["replication.snapshot"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ generation: expect.any(String) as unknown });
  });

  it("listPoints reports the restore points written by snapshot", async () => {
    const { instance } = await boot();
    const snapshot = definePipeline({ name: "snapshot", steps: ["replication.snapshot"] });
    await runPipeline(snapshot, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "listPoints", steps: ["replication.listPoints"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(boundaryCast<unknown[]>(result.result, "host").length).toBeGreaterThan(0);
  });

  it("readStatus reports replication status", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "readStatus", steps: ["replication.readStatus"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ walBytes: expect.any(Number) as unknown });
  });

  it("prepareRestore rebuilds the database at the latest point after a snapshot", async () => {
    const { instance } = await boot();
    const snapshot = definePipeline({ name: "snapshot", steps: ["replication.snapshot"] });
    await runPipeline(snapshot, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "prepareRestore", steps: ["replication.prepareRestore"] });
    const result = await runPipeline(pipeline, { body: {} }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ restartRequired: true });
  });

  it("prepareRestore rejects a non-string generation as VALIDATION before the step runs", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "prepareRestore-invalid", steps: ["replication.prepareRestore"] });
    const result = await runPipeline(pipeline, { body: { generation: 42 } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });

  it("prepareRestore rejects an unknown body key as VALIDATION", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "prepareRestore-extra-key", steps: ["replication.prepareRestore"] });
    const result = await runPipeline(pipeline, { body: { nope: true } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });
});

function writeResult(result: unknown): Step {
  return async (ctx) => ok({ ...ctx, result });
}

describe("replication/sqlite checkRestored", () => {
  async function start(file: string, dir: string, blobs: Blobstore): Promise<{ instance: Replication; bootStartedAt: number }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const bootStartedAt = Date.now();
    const instance = boundaryCast<Replication>(await module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(blobs, dir, bootStartedAt)), "host");
    return { instance, bootStartedAt };
  }

  async function restoredAt(instance: Replication): Promise<unknown> {
    const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["replication.checkRestored"] }), {}, { modules: [{ module, instance }] });
    expect(run.status).toBe(200);
    return boundaryCast<Record<string, unknown>>(run.result, "host")._databaseRestoredAt;
  }

  it("answers the start of the boot that applied a prepared restore, in that boot and every later one, and null for a rebuild of a missing file", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-restored-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.close();
    const blobs = fakeBlobs();
    const first = await start(file, dir, blobs);
    expect(await restoredAt(first.instance)).toBeNull();
    expect((await first.instance.snapshot()).ok).toBe(true);
    expect((await first.instance.prepareRestore({})).ok).toBe(true);
    first.instance.close();

    const restoring = await start(file, dir, blobs);
    expect(await restoredAt(restoring.instance)).toBe(restoring.bootStartedAt);
    restoring.instance.close();
    const later = await start(file, dir, blobs);
    expect(await restoredAt(later.instance)).toBe(restoring.bootStartedAt);
    later.instance.close();

    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
    const rebuilt = await start(file, dir, blobs);
    expect(await restoredAt(rebuilt.instance)).toBeNull();
    rebuilt.instance.close();
  });

  it("leaves a prepared restore whose record could not be written to the next start", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-unrecorded-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.close();
    const blobs = fakeBlobs();
    const first = await start(file, dir, blobs);
    expect((await first.instance.snapshot()).ok).toBe(true);
    expect((await first.instance.prepareRestore({})).ok).toBe(true);
    first.instance.close();

    mkdirSync(join(`${file}.restored-at`, "blocked"), { recursive: true });
    await expect(start(file, dir, blobs)).rejects.toThrow();
    expect(existsSync(`${file}.restore`)).toBe(true);
    rmSync(`${file}.restored-at`, { recursive: true, force: true });
    const applied = await start(file, dir, blobs);
    expect(await restoredAt(applied.instance)).toBe(applied.bootStartedAt);
    applied.instance.close();
  });

  it("keeps the other members of the result", async () => {
    const { instance } = await boot();
    const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["test.earlier", "replication.checkRestored"] }), {}, { modules: [{ module, instance }], steps: { "test.earlier": writeResult({ kept: 1 }) }, writes: { "test.earlier": ["result"] } });
    expect(run.result).toEqual({ kept: 1, _databaseRestoredAt: null });
  });
});
