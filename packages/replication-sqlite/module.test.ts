import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Step } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Manifest, RunEndEvent, RunObserver } from "@michaelthielemann/kestrel";
import type { Deps, Introspection } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { failure } from "@michaelthielemann/kestrel/errors";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import { restoreFromBlobs, type Replication } from "./impl.ts";
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

function freshDir(): string {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-repl-layout-"));
  dirs.push(dir);
  return dir;
}

function image(rows: number): Uint8Array {
  const file = join(freshDir(), "image.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO t (v) VALUES (?)").run(`placed-${i}`);
  db.close();
  return new Uint8Array(readFileSync(file));
}

function place(blobs: ReturnType<typeof fakeBlobs>, generation: string, rows: number, origin: { nonce?: string } | null): void {
  blobs.blobs.set(`replica/gen/${generation}/snapshot.db`, { data: image(rows), contentType: "application/vnd.sqlite3" });
  if (origin) blobs.blobs.set(`replica/gen/${generation}/origin.json`, { data: new TextEncoder().encode(JSON.stringify({ kind: "restore", source: "backup-1", requestedAt: "2026-01-01T00:00:00Z", ...origin })), contentType: "application/json" });
}

function readJson(blobs: ReturnType<typeof fakeBlobs>, key: string): unknown {
  const blob = blobs.blobs.get(key);
  if (!blob) throw new Error(`${key} is missing`);
  return JSON.parse(new TextDecoder().decode(blob.data));
}

function rowsIn(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return boundaryCast<{ n: number }>(db.prepare("SELECT count(*) AS n FROM t").get(), "host").n;
  } finally {
    db.close();
  }
}

function removeDatabase(file: string): void {
  for (const suffix of ["", "-wal", "-shm", ".restored-at"]) rmSync(`${file}${suffix}`, { force: true });
}

async function startOn(file: string, blobs: Blobstore): Promise<{ instance: Replication; bootStartedAt: number }> {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const bootStartedAt = Date.now();
  const instance = boundaryCast<Replication>(await module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(blobs, freshDir(), bootStartedAt)), "host");
  return { instance, bootStartedAt };
}

async function databaseRestoredAt(instance: Replication): Promise<unknown> {
  const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["replication.checkRestored"] }), {}, { modules: [{ module, instance }] });
  expect(run.status).toBe(200);
  return boundaryCast<Record<string, unknown>>(run.result, "host")._databaseRestoredAt;
}

const sixGeneration = (stamp: string, order: number): string => `${stamp}-${order.toString(16).padStart(12, "0")}${"5a".repeat(16)}`;

const stepModules: Record<string, string> = { replication: "replication/sqlite", backup: "backup/blobstore" };

function introspection(pipelines: readonly (readonly string[])[]): Introspection & { stepStart(runId: string, pipeline: string, step: string): void; runEnd(runId: string, outcome: RunEndEvent["outcome"]): void } {
  const observers = new Set<RunObserver>();
  const manifest: Pick<Manifest, "pipelines"> = {
    pipelines: pipelines.map((steps, i) => ({
      name: `pipeline-${i}`,
      steps: steps.map((name) => ({ spec: name, name, module: stepModules[name.slice(0, name.indexOf("."))] ?? "test", description: { summary: name, reads: [], writes: name.endsWith(".checkRestored") ? ["result._databaseRestoredAt"] : [] } })),
    })),
  };
  return {
    describe: () => boundaryCast<Manifest>(manifest, "host"),
    observe(observer) {
      observers.add(observer);
      return () => observers.delete(observer);
    },
    health: () => ({ ok: true, restartRequired: false, modules: [] }),
    stepStart(runId, pipeline, step) {
      for (const observer of observers) observer.stepStart?.({ runId, pipeline, step, at: Date.now() });
    },
    runEnd(runId, outcome) {
      for (const observer of observers) observer.runEnd?.({ runId, pipeline: "pipeline-0", trigger: { kind: "http", name: "test" }, at: Date.now(), ms: 1, status: outcome === "ok" ? 200 : 500, outcome });
    },
  };
}

async function checkRestoredRun(instance: Replication): Promise<{ runId: string; restoredAt: unknown }> {
  const run = await runPipeline(definePipeline({ name: "checkRestored", steps: ["replication.checkRestored"] }), {}, { modules: [{ module, instance }] });
  expect(run.status).toBe(200);
  return { runId: run.runId, restoredAt: boundaryCast<Record<string, unknown>>(run.result, "host")._databaseRestoredAt };
}

function listingLate(blobs: ReturnType<typeof fakeBlobs>, hidden: readonly string[], listings: number): ReturnType<typeof fakeBlobs> & { lists: () => number } {
  let lists = 0;
  return {
    ...blobs,
    lists: () => lists,
    async list(prefix) {
      lists += 1;
      const listed = await blobs.list(prefix);
      if (!listed.ok || lists > listings) return listed;
      return ok(listed.value.filter((info) => !hidden.includes(info.key)));
    },
  };
}

function readsOf<B extends Blobstore>(blobs: B): B & { keys: string[] } {
  const keys: string[] = [];
  return {
    ...blobs,
    keys,
    async get(key) {
      keys.push(key);
      return blobs.get(key);
    },
  };
}

describe("replication/sqlite teardown seal", () => {
  it("ships the frames committed since the last sync and then seals the generation, with no prune or snapshot although both are due", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 0, 1));
    try {
      const dir = freshDir();
      const file = join(dir, "live.db");
      const app = new DatabaseSync(file);
      app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      app.prepare("INSERT INTO t (v) VALUES ('x')").run();
      const blobs = fakeBlobs();
      const instance = boundaryCast<Replication>(await module.setup(configSchema.parse({ file, restoreOnStart: false, snapshotSeconds: 60, retentionSeconds: 60 }), moduleDeps(blobs, dir)), "host");
      const generation = (await instance.sync()).ok ? (await instance.status()).generation : null;
      if (generation === null) throw new Error("expected a generation after the first sync");
      place(blobs, "20251201T000000Z", 1, null);
      place(blobs, "20251202T000000Z", 1, null);
      for (let i = 0; i < 3; i++) app.prepare("INSERT INTO t (v) VALUES ('y')").run();
      app.close();
      vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 5));
      const before = new Set(blobs.blobs.keys());
      const written: string[] = [];
      const put = blobs.put.bind(blobs);
      blobs.put = async (key, data, options) => {
        written.push(key);
        return put(key, data, options);
      };

      await module.teardown!(instance);

      expect([...before].every((key) => blobs.blobs.has(key))).toBe(true);
      expect(written.filter((key) => key.endsWith("/snapshot.db"))).toEqual([]);
      expect(written.at(-1)).toBe(`replica/gen/${generation}/sealed.json`);
      expect(written.slice(0, -1).length).toBeGreaterThan(0);
      expect(written.slice(0, -1).every((key) => key.startsWith(`replica/gen/${generation}/wal/`))).toBe(true);
      const segments = [...blobs.blobs.keys()].filter((key) => key.startsWith(`replica/gen/${generation}/wal/`)).length;
      expect(readJson(blobs, `replica/gen/${generation}/sealed.json`)).toEqual({ lineage: expect.any(Number) as unknown, lastFrame: expect.any(Number) as unknown, segments, at: Date.UTC(2026, 0, 1, 0, 5) });
      const out = join(dir, "restored.db");
      expect((await restoreFromBlobs(blobs, "replica/", { generation }, out)).ok).toBe(true);
      expect(rowsIn(out)).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves no sealed.json behind when the process ends without teardown", async () => {
    const { instance, blobs } = await boot();
    expect((await instance.sync()).ok).toBe(true);
    instance.close();
    open.splice(0);
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/sealed.json"))).toEqual([]);
  });
});

describe("replication/sqlite restore from a placed generation", () => {
  it("reports a restore from a generation placed with origin.json and acknowledges it with applied.json naming the generation and nonce once a sync followed the run that read the report", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 1, null);
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const { instance, bootStartedAt } = await startOn(file, blobs);
    open.push(instance);
    const kestrel = introspection([["replication.checkRestored", "test.render"]]);
    module.attach!(instance, kestrel);
    expect(rowsIn(file)).toBe(2);
    const run = await checkRestoredRun(instance);
    expect(run.restoredAt).toBe(bootStartedAt);
    expect((await instance.sync()).ok).toBe(true);
    expect(blobs.blobs.has("replica/gen/20260102T000000Z/applied.json")).toBe(false);

    kestrel.runEnd(run.runId, "ok");
    const synced = await instance.sync();
    if (!synced.ok) throw new Error("expected a sync");
    const applied = { generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: bootStartedAt };
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual(applied);
    expect(readJson(blobs, `replica/gen/${synced.value.generation}/origin.json`)).toMatchObject({ nonce: "nonce-1" });
    expect(readJson(blobs, `replica/gen/${synced.value.generation}/applied.json`)).toEqual(applied);
    expect(JSON.parse(readFileSync(`${file}.restored-at`, "utf8"))).toEqual({ restoredAtBootStartedAt: bootStartedAt, reported: true });
  });

  it("leaves the restore from a placed generation reported to the next start when the process stops before a run handled the report", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const first = await startOn(file, blobs);
    module.attach!(first.instance, introspection([["replication.checkRestored"]]));
    expect((await first.instance.sync()).ok).toBe(true);
    first.instance.close();
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/applied.json"))).toEqual([]);

    removeDatabase(file);
    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(rowsIn(file)).toBe(2);
    expect(await databaseRestoredAt(second.instance)).toBe(second.bootStartedAt);
  });

  it("leaves the restore from a placed generation reported to the next start on an empty disk when the process stops while its first sync writes a generation", async () => {
    for (const stopsAt of ["origin.json", "snapshot.db"]) {
      const file = join(freshDir(), "live.db");
      const blobs = fakeBlobs();
      place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
      const stopping: Blobstore = {
        ...blobs,
        async put(key, data, options) {
          if (key.endsWith(`/${stopsAt}`)) throw new Error("process stopped");
          return blobs.put(key, data, options);
        },
      };
      const first = await startOn(file, stopping);
      await expect(first.instance.sync()).rejects.toThrow("process stopped");
      first.instance.close();

      removeDatabase(file);
      const second = await startOn(file, blobs);
      open.push(second.instance);
      expect(rowsIn(file)).toBe(2);
      expect(await databaseRestoredAt(second.instance)).toBe(second.bootStartedAt);
    }
  });

  it("leaves the restore from a placed generation reported to the next start when teardown seals a first snapshot of what the process committed before the report was handled", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const first = await startOn(file, blobs);
    const app = new DatabaseSync(file);
    app.prepare("INSERT INTO t (v) VALUES ('migrated')").run();
    app.close();
    await module.teardown!(first.instance);
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/sealed.json"))).toHaveLength(1);

    removeDatabase(file);
    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(rowsIn(file)).toBe(3);
    expect(await databaseRestoredAt(second.instance)).toBe(second.bootStartedAt);
  });

  it("does not acknowledge the restore while the run that read the report failed", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const first = await startOn(file, blobs);
    const kestrel = introspection([["replication.checkRestored", "test.render"]]);
    module.attach!(first.instance, kestrel);
    kestrel.runEnd((await checkRestoredRun(first.instance)).runId, "fail");
    expect((await first.instance.sync()).ok).toBe(true);
    first.instance.close();
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/applied.json"))).toEqual([]);

    removeDatabase(file);
    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(await databaseRestoredAt(second.instance)).toBe(second.bootStartedAt);
  });

  it("acknowledges the restore only after a run through backup.checkRestored when that step reads the report instead", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const { instance, bootStartedAt } = await startOn(file, blobs);
    open.push(instance);
    const kestrel = introspection([["backup.checkRestored", "delivery.checkBuild"], ["test.other"]]);
    module.attach!(instance, kestrel);
    kestrel.stepStart("other-run", "pipeline-1", "test.other");
    kestrel.runEnd("other-run", "ok");
    expect((await instance.sync()).ok).toBe(true);
    expect(blobs.blobs.has("replica/gen/20260102T000000Z/applied.json")).toBe(false);

    kestrel.stepStart("boot-run", "pipeline-0", "backup.checkRestored");
    kestrel.runEnd("boot-run", "ok");
    expect((await instance.sync()).ok).toBe(true);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual({ generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: bootStartedAt });
  });

  it("acknowledges the restore at the first sync when no pipeline reads the report", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const { instance, bootStartedAt } = await startOn(file, blobs);
    open.push(instance);
    module.attach!(instance, introspection([["replication.sync"]]));
    expect((await instance.sync()).ok).toBe(true);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual({ generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: bootStartedAt });
  });

  it("acknowledges the restore in a later start on the same file when the start that restored it stopped first", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const first = await startOn(file, blobs);
    first.instance.close();

    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(await databaseRestoredAt(second.instance)).toBe(first.bootStartedAt);
    module.attach!(second.instance, introspection([]));
    expect((await second.instance.sync()).ok).toBe(true);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual({ generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: first.bootStartedAt });
    expect(JSON.parse(readFileSync(`${file}.restored-at`, "utf8"))).toEqual({ restoredAtBootStartedAt: first.bootStartedAt, reported: true });
  });

  it("reports the placed generation again only while no applied.json acknowledges it", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const first = await startOn(file, blobs);
    module.attach!(first.instance, introspection([]));
    const synced = await first.instance.sync();
    if (!synced.ok) throw new Error("expected a sync");
    first.instance.close();
    for (const key of [...blobs.blobs.keys()]) if (key.includes(synced.value.generation)) blobs.blobs.delete(key);

    removeDatabase(file);
    const acknowledged = await startOn(file, blobs);
    expect(await databaseRestoredAt(acknowledged.instance)).toBeNull();
    acknowledged.instance.close();

    removeDatabase(file);
    blobs.blobs.delete("replica/gen/20260102T000000Z/applied.json");
    const unacknowledged = await startOn(file, blobs);
    open.push(unacknowledged.instance);
    expect(await databaseRestoredAt(unacknowledged.instance)).toBe(unacknowledged.bootStartedAt);
  });

  it("reports a restore from a placed generation whose origin.json the listing does not show yet", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 1, null);
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const late = listingLate(blobs, ["replica/gen/20260102T000000Z/origin.json"], 1);
    const { instance, bootStartedAt } = await startOn(file, late);
    open.push(instance);
    expect(rowsIn(file)).toBe(2);
    expect(await databaseRestoredAt(instance)).toBe(bootStartedAt);
  });

  it("starts from a placed generation after one named with an order key while the listing does not show its origin.json yet", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1)), 1, null);
    place(blobs, "20260102T000000Z", 3, { nonce: "nonce-1" });
    const late = listingLate(blobs, ["replica/gen/20260102T000000Z/origin.json"], 1);
    const { instance, bootStartedAt } = await startOn(file, late);
    open.push(instance);
    expect(rowsIn(file)).toBe(3);
    expect(await databaseRestoredAt(instance)).toBe(bootStartedAt);
  });

  it("never reads an applied.json while it restores from a placed generation and acknowledges the restore", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const reads = readsOf(blobs);
    const { instance, bootStartedAt } = await startOn(file, reads);
    open.push(instance);
    module.attach!(instance, introspection([]));
    expect((await instance.sync()).ok).toBe(true);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual({ generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: bootStartedAt });
    expect(reads.keys.filter((key) => key.endsWith("/applied.json"))).toEqual([]);
  });

  it("reports the restore once more while the listing does not show the applied.json that acknowledges it", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    blobs.blobs.set("replica/gen/20260102T000000Z/applied.json", { data: new TextEncoder().encode(JSON.stringify({ generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: 1 })), contentType: "application/json" });
    const late = readsOf(listingLate(blobs, ["replica/gen/20260102T000000Z/applied.json"], 1));
    const { instance, bootStartedAt } = await startOn(file, late);
    open.push(instance);
    expect(await databaseRestoredAt(instance)).toBe(bootStartedAt);
    expect(late.keys.filter((key) => key.endsWith("/applied.json"))).toEqual([]);
  });

  it("neither reports the restore again nor writes applied.json when the listing shows it, whatever a read of it would answer", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const applied = { generation: "20260102T000000Z", nonce: "nonce-1", restoredAt: 1 };
    blobs.blobs.set("replica/gen/20260102T000000Z/applied.json", { data: new TextEncoder().encode(JSON.stringify(applied)), contentType: "application/json" });
    const written: string[] = [];
    const unreadable: Blobstore = {
      ...blobs,
      async get(key) {
        return key.endsWith("/applied.json") ? err(failure("TRANSIENT", "applied.json unreadable")) : blobs.get(key);
      },
      async put(key, data, options) {
        written.push(key);
        return blobs.put(key, data, options);
      },
    };
    const { instance } = await startOn(file, unreadable);
    open.push(instance);
    expect(await databaseRestoredAt(instance)).toBeNull();
    module.attach!(instance, introspection([]));
    instance.restoreHandled();
    expect((await instance.sync()).ok).toBe(true);
    expect(written.filter((key) => key.endsWith(".json"))).toEqual([]);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual(applied);
  });

  it("lists again while a generation with origin.json after the newest snapshot shows no snapshot.db yet, then restores from it", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 1, null);
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const late = listingLate(blobs, ["replica/gen/20260102T000000Z/snapshot.db"], 1);
    const { instance, bootStartedAt } = await startOn(file, late);
    open.push(instance);
    expect(late.lists()).toBe(2);
    expect(rowsIn(file)).toBe(2);
    expect(await databaseRestoredAt(instance)).toBe(bootStartedAt);
  });

  it("refuses to start while repeated listings show origin.json of a generation after the newest snapshot but no snapshot.db in it", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 1, null);
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const late = listingLate(blobs, ["replica/gen/20260102T000000Z/snapshot.db"], 100);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const started = module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(late, freshDir(), Date.now())).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(String(await started)).toMatch(/origin\.json in generation 20260102T000000Z [^]*no snapshot\.db/);
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(file)).toBe(false);
  });

  it("reports the restore from a placed generation in the next start on the same disk when the start that rebuilt the file stopped while it read origin.json", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, { nonce: "nonce-1" });
    const stopping: Blobstore = {
      ...blobs,
      async get(key) {
        if (key.endsWith("/origin.json")) throw new Error("process stopped");
        return blobs.get(key);
      },
    };
    await expect(module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(stopping, freshDir(), Date.now()))).rejects.toThrow("process stopped");

    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(rowsIn(file)).toBe(2);
    expect(await databaseRestoredAt(second.instance)).toBe(second.bootStartedAt);
  });

  it("leaves no WAL of an earlier database next to the file it rebuilds", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 2, null);
    const otherFile = join(freshDir(), "other.db");
    const other = new DatabaseSync(otherFile);
    other.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    for (let i = 0; i < 5; i++) other.prepare("INSERT INTO t (v) VALUES ('stale')").run();
    copyFileSync(`${otherFile}-wal`, `${file}-wal`);
    other.close();

    const { instance } = await startOn(file, blobs);
    open.push(instance);
    expect(rowsIn(file)).toBe(2);
  });

  it("names a null nonce in applied.json when origin.json holds none", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260102T000000Z", 1, {});
    const { instance, bootStartedAt } = await startOn(file, blobs);
    open.push(instance);
    module.attach!(instance, introspection([]));
    expect((await instance.sync()).ok).toBe(true);
    expect(readJson(blobs, "replica/gen/20260102T000000Z/applied.json")).toEqual({ generation: "20260102T000000Z", nonce: null, restoredAt: bootStartedAt });
  });
});

describe("replication/sqlite start with a generation of unknown origin", () => {
  it("refuses to start when a generation named by its time alone, without origin.json, sorts after the newest generation named with an order key", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    const own = sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1));
    place(blobs, own, 2, null);
    place(blobs, "20260102T000000Z", 0, null);
    await expect(startOn(file, blobs)).rejects.toThrow(new RegExp(`20260102T000000Z[^]*origin\\.json[^]*${own}`));
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to start when such a generation sorts after one placed with origin.json", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 2, { nonce: "nonce-1" });
    place(blobs, "20260102T000000Z", 0, null);
    await expect(startOn(file, blobs)).rejects.toThrow(/refusing to restore/);
    expect(existsSync(file)).toBe(false);
  });

  it("starts from a newer generation named by its time alone when it carries origin.json", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1)), 2, null);
    place(blobs, "20260102T000000Z", 3, { nonce: "nonce-1" });
    const { instance } = await startOn(file, blobs);
    open.push(instance);
    expect(rowsIn(file)).toBe(3);
  });

  it("starts from the newest generation of a replica that holds only generations named by their time alone", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, "20260101T000000Z", 1, null);
    place(blobs, "20260102T000000Z", 2, null);
    const { instance } = await startOn(file, blobs);
    open.push(instance);
    expect(rowsIn(file)).toBe(2);
    expect(await databaseRestoredAt(instance)).toBeNull();
  });
});

describe("replication/sqlite another writer after the start", () => {
  it("notes a segment that another process ships into the restored generation after the start listed the replica, before the first sync", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    const previous = sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1));
    place(blobs, previous, 1, null);
    const { instance } = await startOn(file, blobs);
    open.push(instance);
    const late = new Date(Date.now() + 2000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    blobs.blobs.set(`replica/gen/${previous}/wal/000001-000000-${late}.wal`, { data: new Uint8Array([1]), contentType: "application/octet-stream" });
    expect((await instance.sync()).ok).toBe(true);
    expect(instance.health()).toEqual({ ok: true, note: expect.stringContaining(`${previous}/wal/`) as unknown });
  });

  it("notes a generation that another process starts after the start listed the replica, before the first sync", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    place(blobs, sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1)), 1, null);
    const { instance } = await startOn(file, blobs);
    open.push(instance);
    const other = sixGeneration("20260101T000001Z", Date.UTC(2026, 0, 1, 0, 0, 1));
    place(blobs, other, 1, null);
    expect((await instance.sync()).ok).toBe(true);
    expect(instance.health()).toEqual({ ok: true, note: expect.stringContaining(`${other}/snapshot.db`) as unknown });
  });
});

describe("replication/sqlite restore of a sealed generation", () => {
  it("restores every row a process committed before its teardown sealed the generation", async () => {
    const dir = freshDir();
    const file = join(dir, "live.db");
    const blobs = fakeBlobs();
    const first = await startOn(file, blobs);
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.prepare("INSERT INTO t (v) VALUES ('synced')").run();
    expect((await first.instance.sync()).ok).toBe(true);
    for (let i = 0; i < 4; i++) app.prepare("INSERT INTO t (v) VALUES ('after the last sync')").run();
    app.close();
    await module.teardown!(first.instance);
    expect([...blobs.blobs.keys()].filter((key) => key.endsWith("/sealed.json"))).toHaveLength(1);

    removeDatabase(file);
    const second = await startOn(file, blobs);
    open.push(second.instance);
    expect(rowsIn(file)).toBe(5);
  });

  async function teardownAfterUnsyncedRows(): Promise<{ file: string; blobs: ReturnType<typeof fakeBlobs>; written: string[] }> {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    const first = await startOn(file, blobs);
    const app = new DatabaseSync(file);
    app.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    app.prepare("INSERT INTO t (v) VALUES ('synced')").run();
    expect((await first.instance.sync()).ok).toBe(true);
    for (let i = 0; i < 4; i++) app.prepare("INSERT INTO t (v) VALUES ('after the last sync')").run();
    app.close();
    const before = new Set(blobs.blobs.keys());
    await module.teardown!(first.instance);
    removeDatabase(file);
    const written = [...blobs.blobs.keys()].filter((key) => !before.has(key));
    expect(written).toEqual([expect.stringMatching(/\/wal\/000001-000000-\d{8}T\d{6}Z\.wal$/), expect.stringMatching(/\/sealed\.json$/)]);
    return { file, blobs, written };
  }

  it("lists again while the listing shows neither the last WAL segment nor the seal of the newest generation, then restores every row", async () => {
    const { file, blobs, written } = await teardownAfterUnsyncedRows();
    const late = listingLate(blobs, written, 1);
    const second = await startOn(file, late);
    open.push(second.instance);
    expect(late.lists()).toBe(2);
    expect(rowsIn(file)).toBe(5);
  });

  it("refuses to restore while repeated listings show neither the last WAL segment nor the seal of the newest generation", async () => {
    const { file, blobs, written } = await teardownAfterUnsyncedRows();
    const late = listingLate(blobs, written, 100);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const started = module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(late, freshDir(), Date.now())).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(String(await started)).toMatch(/sealed\.json names 1 WAL segments, but repeated listings of replica\/gen\/[^/]+\/wal\/ show only 0/);
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to restore while the listing lacks a WAL segment that the newest generation's seal names", async () => {
    const file = join(freshDir(), "live.db");
    const blobs = fakeBlobs();
    const generation = sixGeneration("20260101T000000Z", Date.UTC(2026, 0, 1));
    place(blobs, generation, 1, null);
    blobs.blobs.set(`replica/gen/${generation}/sealed.json`, { data: new TextEncoder().encode(JSON.stringify({ lineage: 1, lastFrame: 4, segments: 2, at: 0 })), contentType: "application/json" });
    blobs.blobs.set(`replica/gen/${generation}/wal/000001-000000-20260101T000001Z.wal`, { data: new Uint8Array([1]), contentType: "application/octet-stream" });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const started = module.setup(configSchema.parse({ file, restoreOnStart: true }), moduleDeps(blobs, freshDir(), Date.now())).then(() => null, (error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await started;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(new RegExp(`sealed\\.json names 2 WAL segments, but repeated listings of replica/gen/${generation}/wal/ show only 1`));
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(file)).toBe(false);
  });
});
