import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { BLOBSTORE, type Blobstore, type BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { expectErr, expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { createContext } from "@michaelthielemann/kestrel/context";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, ok } from "@michaelthielemann/kestrel/result";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { applyPendingRestore, createBackupBlobstore, exists, pendingRestoreFile, restoreMarker, versionKey } from "./impl.ts";
import module from "./module.ts";

function fakeBlobstore(): Blobstore & { blobs: Map<string, { data: Uint8Array; contentType: string }>; failNext(code: "TRANSIENT"): void } {
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  let pending: "TRANSIENT" | null = null;
  const injected = (): BlobstoreError | null => {
    if (pending === null) return null;
    pending = null;
    return failure("TRANSIENT", "fakeBlobstore: injected TRANSIENT");
  };
  return {
    blobs,
    failNext(code) {
      pending = code;
    },
    async put(key, data, options) {
      const e = injected();
      if (e) return err(e);
      blobs.set(key, { data, contentType: options?.contentType ?? "application/octet-stream" });
      return ok();
    },
    async get(key) {
      const e = injected();
      if (e) return err(e);
      return ok(blobs.get(key)?.data ?? null);
    },
    async remove(key) {
      const e = injected();
      if (e) return err(e);
      blobs.delete(key);
      return ok();
    },
    async move(from, to) {
      const e = injected();
      if (e) return err(e);
      const b = blobs.get(from);
      if (!b) return err(failure("NOT_FOUND", `${from} not found`));
      blobs.set(to, b);
      blobs.delete(from);
      return ok();
    },
    async list(prefix) {
      const e = injected();
      if (e) return err(e);
      return ok([...blobs].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.data.byteLength })));
    },
  };
}

function deps(blobs: Blobstore, root: string): Deps {
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
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe("backup/blobstore", () => {
  it("backs up a file and restores it into a missing path", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "data", "kestrel.db");
    const blobs = fakeBlobstore();
    await writeFile(join(dir, "src.db"), "hello");
    const src = createBackupBlobstore({ file: join(dir, "src.db"), key: "backups/kestrel.db", restoreOnStart: true, versions: 0 }, blobs);
    expect(expectOk(await src.backup())).toEqual({ key: "backups/kestrel.db", size: 5, versions: [] });

    const dst = createBackupBlobstore({ file, key: "backups/kestrel.db", restoreOnStart: true, versions: 0 }, blobs);
    expect(await exists(file)).toBe(false);
    expect(await dst.restoreWhenMissing()).toEqual({ restored: true, key: "backups/kestrel.db", size: 5 });
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("restoreWhenMissing leaves an existing file untouched", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "live.db");
    const blobs = fakeBlobstore();
    await writeFile(file, "live");
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("stale"), contentType: "application/octet-stream" });
    const b = createBackupBlobstore({ file, key: "backups/db", restoreOnStart: true, versions: 0 }, blobs);
    expect(await b.restoreWhenMissing()).toEqual({ restored: false, key: "backups/db", size: 0 });
    expect(await readFile(file, "utf8")).toBe("live");
  });

  it("restore without a backup answers NOT_FOUND and does nothing", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const b = createBackupBlobstore({ file: join(dir, "x.db"), key: "none", restoreOnStart: true, versions: 0 }, fakeBlobstore());
    expect(await b.restoreWhenMissing()).toEqual({ restored: false, key: "none", size: 0 });
    const error = expectErr(await b.prepareRestore(), "NOT_FOUND");
    expect(error.message).toMatch(/no backup at none/);
    expect(await exists(join(dir, "x.db"))).toBe(false);
    expect(await exists(restoreMarker(join(dir, "x.db")))).toBe(false);
  });

  it("prepareRestore stages the blob next to the live file and setup swaps it in on the next start", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await writeFile(file, "live");
    await writeFile(`${file}-wal`, "wal");
    const b = createBackupBlobstore({ file, key: "backups/db", restoreOnStart: false, versions: 0 }, blobs);

    expect(expectOk(await b.prepareRestore())).toEqual({ prepared: true, key: "backups/db", size: 11, file: pendingRestoreFile(file) });
    expect(await readFile(file, "utf8")).toBe("live");
    expect(await readFile(restoreMarker(file), "utf8")).toBe("backups/db");

    expect(await applyPendingRestore(file)).toEqual({ key: "backups/db", size: 11 });
    expect(await readFile(file, "utf8")).toBe("from-backup");
    expect(await exists(`${file}-wal`)).toBe(false);
    expect(await exists(pendingRestoreFile(file))).toBe(false);
    expect(await exists(restoreMarker(file))).toBe(false);
    expect(await applyPendingRestore(file)).toBeNull();
  });

  it("a marker without a staged file is dropped instead of applied", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "live");
    await writeFile(restoreMarker(file), "backups/db");
    expect(await applyPendingRestore(file)).toBeNull();
    expect(await readFile(file, "utf8")).toBe("live");
    expect(await exists(restoreMarker(file))).toBe(false);
  });

  it("the restore step reports a pending restore and setup applies it", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    blobs.blobs.set("backups/db", { data: new TextEncoder().encode("from-backup"), contentType: "application/octet-stream" });
    await writeFile(file, "live");
    const instance = await module.setup(module.configSchema.parse({ file, key: "backups/db", restoreOnStart: true, versions: 0 }), deps(blobs, dir));
    const restore = module.steps!(instance).restore;

    const result = expectOk(await restore(createContext({ trigger: { kind: "http", name: "t" }, payload: {} })));
    expect(result.result).toEqual({ key: "backups/db", size: 11, file: pendingRestoreFile(file), pending: true, appliedOnRestart: true });
    expect(await readFile(file, "utf8")).toBe("live");

    await module.setup(module.configSchema.parse({ file, key: "backups/db", restoreOnStart: true, versions: 0 }), deps(blobs, dir));
    expect(await readFile(file, "utf8")).toBe("from-backup");
  });

  it("keeps timestamped versions, prunes old ones and restores a chosen version", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "db");
    const blobs = fakeBlobstore();
    let t = Date.UTC(2026, 0, 1);
    const b = createBackupBlobstore({ file, key: "backups/db", restoreOnStart: true, versions: 2 }, blobs, () => t);
    for (const content of ["v1", "v2", "v3"]) {
      await writeFile(file, content);
      expectOk(await b.backup());
      t += 60_000;
    }
    const versions = expectOk(await b.versions());
    expect(versions).toEqual([versionKey("backups/db", Date.UTC(2026, 0, 1) + 120_000), versionKey("backups/db", Date.UTC(2026, 0, 1) + 60_000)]);
    expect(blobs.blobs.size).toBe(3);
    expect(expectOk(await b.prepareRestore(versions[1]))).toMatchObject({ prepared: true, key: versions[1], size: 2 });
    expect(await applyPendingRestore(file)).toMatchObject({ key: versions[1] });
    expect(await readFile(file, "utf8")).toBe("v2");
    expectOk(await b.prepareRestore());
    await applyPendingRestore(file);
    expect(await readFile(file, "utf8")).toBe("v3");
    await expect(b.prepareRestore("media/some-upload.png")).rejects.toThrow(/not a backup of/);
  });

  it("two boots keep their own key; the first instance's restore step still accepts its own key after a second boot with a different key", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const blobsA = fakeBlobstore();
    const first = await module.setup(module.configSchema.parse({ file: join(dir, "a.db"), key: "backups/a", restoreOnStart: false, versions: 0 }), deps(blobsA, dir));
    await module.setup(module.configSchema.parse({ file: join(dir, "b.db"), key: "backups/b", restoreOnStart: false, versions: 0 }), deps(fakeBlobstore(), dir));
    await writeFile(join(dir, "src.db"), "hello");
    expectOk(await createBackupBlobstore({ file: join(dir, "src.db"), key: "backups/a", restoreOnStart: false, versions: 0 }, blobsA).backup());
    const restore = module.steps!(first).restore;
    const result = expectOk(await restore(createContext({ trigger: { kind: "http", name: "t" }, payload: { key: "backups/a" } })));
    expect(result.result).toMatchObject({ key: "backups/a", pending: true, appliedOnRestart: true });
  });

  it("an unknown backup version is a VALIDATION failure", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    const blobs = fakeBlobstore();
    const instance = await module.setup(module.configSchema.parse({ file, key: "backups/db", restoreOnStart: false, versions: 0 }), deps(blobs, dir));
    const restore = module.steps!(instance).restore;
    const error = expectErr(await restore(createContext({ trigger: { kind: "http", name: "t" }, payload: { key: "backups/db.nope" } })), "VALIDATION");
    expect(error.message).toMatch(/unknown backup version/);
  });

  it("a transient blobstore failure surfaces as a retryable 503 from backup.run", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "kestrel-backup-"));
    dirs.push(dir);
    const file = join(dir, "kestrel.db");
    await writeFile(file, "hello");
    const blobs = fakeBlobstore();
    const instance = await module.setup(module.configSchema.parse({ file, key: "backups/db", restoreOnStart: false, versions: 0 }), deps(blobs, dir));
    const run = module.steps!(instance).run;
    blobs.failNext("TRANSIENT");
    const error = expectErr(await run(createContext({ trigger: { kind: "http", name: "t" }, payload: {} })), "TRANSIENT");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
  });
});
