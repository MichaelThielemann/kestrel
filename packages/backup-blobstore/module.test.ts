import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { ok } from "@michaelthielemann/kestrel/result";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { Backup } from "./impl.ts";
import module, { configSchema } from "./module.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }> } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  return {
    blobs,
    async put(key, data, options) {
      blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(key) {
      return ok(blobs.get(key)?.data ?? null);
    },
    async remove(key) {
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const b = blobs.get(from);
      if (!b) throw new Error(`${from} not found`);
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength })));
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
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function boot(): Promise<Backup> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-mod-"));
  dirs.push(dir);
  const file = join(dir, "kestrel.db");
  await writeFile(file, "hello");
  const blobs = fakeBlobstore();
  const config = configSchema.parse({ file, key: "backups/db", restoreOnStart: false, versions: 2 });
  return (await module.setup(config, moduleDeps(blobs, dir))) as Backup;
}

describe("backup/blobstore module via runPipeline", () => {
  it("run backs up the file and reports key and size", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "run", steps: ["backup.run"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ key: "backups/db", size: 5 });
  });

  it("listVersions lists the versions written by run", async () => {
    const instance = await boot();
    const run = definePipeline({ name: "run", steps: ["backup.run"] });
    await runPipeline(run, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "listVersions", steps: ["backup.listVersions"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect((result.result as { versions: string[] }).versions.length).toBe(1);
  });

  it("restore stages the latest version to be applied on the next start", async () => {
    const instance = await boot();
    const run = definePipeline({ name: "run", steps: ["backup.run"] });
    await runPipeline(run, {}, { modules: [{ module, instance }] });
    const pipeline = definePipeline({ name: "restore", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: {} }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toMatchObject({ key: "backups/db", pending: true, appliedOnRestart: true });
  });

  it("restore rejects a non-string key as VALIDATION before the step runs", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "restore-invalid", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: { key: 123 } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });

  it("restore rejects an unknown body key as VALIDATION", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "restore-extra-key", steps: ["backup.restore"] });
    const result = await runPipeline(pipeline, { body: { key: "backups/db", nope: true } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
  });
});
