import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
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

function moduleDeps(blobs: Blobstore, root: string): Deps {
  return {
    get<T>(contract: Contract<T>): T {
      if (contract.name !== BLOBSTORE.name) throw new Error(`no provider for "${contract.name}"`);
      return blobs as T;
    },
    find: <T>(): T | undefined => undefined,
    logger: silentLogger,
    root,
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
  const instance = (await module.setup(config, moduleDeps(blobs, dir))) as Replication;
  open.push(instance);
  return { instance, blobs };
}

describe("replication/sqlite module via runPipeline", () => {
  it("sync ships the current state as a first snapshot", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "sync", steps: ["replication.sync"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ generation: expect.any(String) as string });
  });

  it("snapshot starts a new generation", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "snapshot", steps: ["replication.snapshot"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ generation: expect.any(String) as string });
  });

  it("listPoints reports the restore points written by snapshot", async () => {
    const { instance } = await boot();
    const snapshot = definePipeline({ name: "snapshot", steps: ["replication.snapshot"] });
    await runPipeline(snapshot, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "listPoints", steps: ["replication.listPoints"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect((result.result as unknown[]).length).toBeGreaterThan(0);
  });

  it("readStatus reports replication status", async () => {
    const { instance } = await boot();
    const pipeline = definePipeline({ name: "readStatus", steps: ["replication.readStatus"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ walBytes: expect.any(Number) as number });
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
