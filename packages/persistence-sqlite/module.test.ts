import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { expectOk } from "@michaelthielemann/kestrel-contracts/testing/result";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import type { Contract } from "@michaelthielemann/kestrel/defineContract";
import type { Deps } from "@michaelthielemann/kestrel/defineModule";
import { definePipeline } from "@michaelthielemann/kestrel/definePipeline";
import { isKestrelBootError } from "@michaelthielemann/kestrel/errors";
import { acquireInstanceLock, instanceLockFile, type InstanceLock } from "@michaelthielemann/kestrel/instanceLock";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { runPipeline } from "@michaelthielemann/kestrel/testing/runPipeline";
import type { PersistenceSqlite } from "./impl.ts";
import module, { configSchema } from "./module.ts";

const deps: Deps = {
  get<T>(contract: Contract<T>): T {
    throw new Error(`no provider for "${contract.name}"`);
  },
  find: <T>(): T | undefined => undefined,
  logger: silentLogger,
  root: process.cwd(),
  eventTriggers: [],
};

async function boot(): Promise<PersistenceSqlite> {
  const instance = boundaryCast<PersistenceSqlite>(await module.setup(configSchema.parse({ file: ":memory:", acquireTimeoutMs: 15000 }), deps), "host");
  await instance.ensureCollection("t", { a: "string" });
  return instance;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("persistence/sqlite module via runPipeline", () => {
  it("createOne stores the body and findOne reads it back by params.id", async () => {
    const instance = await boot();
    const create = definePipeline({ name: "create", steps: ["persistence.createOne:t"] });
    const created = await runPipeline(create, { body: { a: "x" } }, { modules: [{ module, instance }] });
    expect(created.status).toBe(200);
    const id = boundaryCast<{ id: string }>(created.result, "host").id;

    const find = definePipeline({ name: "find", steps: ["persistence.findOne:t"] });
    const found = await runPipeline(find, { params: { id } }, { modules: [{ module, instance }] });
    expect(found.status).toBe(200);
    expect(found.result).toEqual({ id, a: "x" });
    instance.close();
  });

  it("createOne rejects a non-object body as VALIDATION before the step runs", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "create-invalid", steps: ["persistence.createOne:t"] });
    const result = await runPipeline(pipeline, { body: boundaryCast<Record<string, unknown>>(JSON.parse("[]"), "json") }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
    instance.close();
  });

  it("findMany lists every document", async () => {
    const instance = await boot();
    expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "findMany", steps: ["persistence.findMany:t"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(boundaryCast<{ total: number }>(result.result, "host").total).toBe(1);
    instance.close();
  });

  it("updateOne patches the document named by params.id", async () => {
    const instance = await boot();
    const created = expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "update", steps: ["persistence.updateOne:t"] });
    const result = await runPipeline(pipeline, { params: { id: created.id }, body: { a: "y" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ id: created.id, a: "y" });
    instance.close();
  });

  it("updateOne answers VALIDATION without params.id", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "update-no-id", steps: ["persistence.updateOne:t"] });
    const result = await runPipeline(pipeline, { body: { a: "y" } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(400);
    expect(result.code).toBe("VALIDATION");
    instance.close();
  });

  it("deleteOne removes the document named by params.id", async () => {
    const instance = await boot();
    const created = expectOk(await instance.createOne("t", { a: "x" }));
    const pipeline = definePipeline({ name: "delete", steps: ["persistence.deleteOne:t"] });
    const result = await runPipeline(pipeline, { params: { id: created.id } }, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ ok: true });
    instance.close();
  });

  it("checkpoint runs without a payload", async () => {
    const instance = await boot();
    const pipeline = definePipeline({ name: "checkpoint", steps: ["persistence.checkpoint"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    instance.close();
  });

  it("snapshot writes a copy of the database to the given file", async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-mod-"));
    dirs.push(dir);
    const instance = await boot();
    const file = join(dir, "copy.db");
    const pipeline = definePipeline({ name: "snapshot", steps: [`persistence.snapshot:${file}`] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(result.result).toEqual({ file });
    instance.close();
  });

  it("the checkpoint step awaits an async checkpoint() before the run ends", async () => {
    const real = await boot();
    let resolved = false;
    const instance: PersistenceSqlite = {
      ...real,
      checkpoint: async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
      },
    };
    const pipeline = definePipeline({ name: "checkpoint", steps: ["persistence.checkpoint"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(resolved).toBe(true);
    real.close();
  });

  it("the snapshot step awaits an async snapshot() before the run ends", async () => {
    const real = await boot();
    let resolved = false;
    const instance: PersistenceSqlite = {
      ...real,
      snapshot: async () => {
        await new Promise((r) => setTimeout(r, 20));
        resolved = true;
      },
    };
    const pipeline = definePipeline({ name: "snapshot", steps: ["persistence.snapshot:copy.db"] });
    const result = await runPipeline(pipeline, {}, { modules: [{ module, instance }] });
    expect(result.status).toBe(200);
    expect(resolved).toBe(true);
    real.close();
  });
});

const MODULE_URL = new URL("./module.ts", import.meta.url).href;
const children: ChildProcess[] = [];
const shares: InstanceLock[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const share of shares.splice(0)) share.release();
});

function lockFileOf(file: string): string {
  const path = instanceLockFile(file);
  if (path === undefined) throw new Error(`${file} names no lock file`);
  return path;
}

function holdForeignLock(file: string): string {
  const now = new Date().toISOString();
  const record = { instanceId: randomUUID(), pid: 4242, pidNamespace: "pid:[4026530001]", processStart: "1", clockStart: 1, bootId: randomUUID(), host: "other-host", startedAt: now, heartbeatAt: now, ttlMs: 60_000, threads: { [randomUUID()]: now } };
  const content = JSON.stringify(record);
  writeFileSync(lockFileOf(file), content);
  return content;
}

function checksums(paths: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((path) => [path, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null]));
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected setup to fail");
    },
    (error: unknown) => error,
  );
}

function holdInChild(file: string, dir: string): Promise<number> {
  const script = join(dir, "hold.mjs");
  writeFileSync(
    script,
    [
      `import module, { configSchema } from ${JSON.stringify(MODULE_URL)};`,
      `const logger = { step() {}, info() {}, warn() {}, error() {} };`,
      `const deps = { get() { throw new Error("no provider"); }, find: () => undefined, logger, root: process.cwd(), eventTriggers: [] };`,
      `const db = await module.setup(configSchema.parse({ file: process.argv[2] }), deps);`,
      `await db.ensureCollection("t", { a: "string" });`,
      `await db.createOne("t", { a: "held" });`,
      `process.stdout.write("ready\\n");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, file], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("ready\n") && child.pid !== undefined) resolve(child.pid);
    });
    child.on("exit", (code) => reject(new Error(`the holding process exited with ${String(code)}`)));
  });
}

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "kestrel-sqlite-lock-")));
  dirs.push(dir);
  return dir;
}

async function setUp(config: Record<string, unknown>): Promise<PersistenceSqlite> {
  return boundaryCast<PersistenceSqlite>(await module.setup(configSchema.parse(config), deps), "host");
}

describe("persistence/sqlite instance lock", () => {
  it("refuses a file that another process has set up, naming its host and PID, and leaves the database files unchanged", async () => {
    const dir = tempDir();
    const file = join(dir, "app.db");
    const pid = await holdInChild(file, dir);
    const files = [file, `${file}-wal`, `${file}-shm`];
    const before = checksums(files);

    const error = await failureOf(setUp({ file }));

    expect(isKestrelBootError(error)).toBe(true);
    expect(error).toMatchObject({ code: "instance-locked", module: "persistence/sqlite" });
    expect(String(error)).toContain(`pid ${pid}`);
    expect(String(error)).toContain(hostname());
    expect(String(error)).toContain("allowConcurrentProcesses: true");
    expect(checksums(files)).toEqual(before);
  });

  it("refuses before it creates the database file", async () => {
    const dir = tempDir();
    const file = join(dir, "app.db");
    holdForeignLock(file);

    expect(await failureOf(setUp({ file }))).toMatchObject({ code: "instance-locked" });
    expect(readdirSync(dir)).toEqual(["app.db.instance"]);
  });

  it("sets up beside another process's lock with allowConcurrentProcesses and leaves that lock as it is", async () => {
    const dir = tempDir();
    const file = join(dir, "app.db");
    const held = holdForeignLock(file);

    const db = await setUp({ file, allowConcurrentProcesses: true });
    await module.teardown!(db);

    expect(readFileSync(lockFileOf(file), "utf8")).toBe(held);
  });

  it("takes no lock for an in-memory database", async () => {
    const memoryEntries = () => readdirSync(process.cwd()).filter((name) => name.startsWith(":memory:"));
    expect(memoryEntries()).toEqual([]);
    const db = await setUp({ file: ":memory:" });
    expect(memoryEntries()).toEqual([]);
    expect(module.health!(db)).toEqual({ ok: true });
    await module.teardown!(db);
  });

  it("holds the lock beside the file until teardown, outside the database and its snapshots", async () => {
    const dir = tempDir();
    const file = join(dir, "app.db");
    const db = await setUp({ file });
    await db.ensureCollection("t", { a: "string" });
    expect(existsSync(lockFileOf(file))).toBe(true);

    const copy = join(dir, "copy.db");
    const run = await runPipeline(definePipeline({ name: "snapshot", steps: [`persistence.snapshot:${copy}`] }), {}, { modules: [{ module, instance: db }] });
    expect(run.status).toBe(200);
    expect(existsSync(`${copy}.instance`)).toBe(false);
    const snapshot = new DatabaseSync(copy, { readOnly: true });
    const tables = boundaryCast<Array<{ name: string }>>(snapshot.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(), "host").map((row) => row.name);
    snapshot.close();
    expect(tables).toEqual(["t"]);

    await module.teardown!(db);
    expect(existsSync(lockFileOf(file))).toBe(false);
  });

  it("reports a lock that another instance took over as needing a restart", async () => {
    const dir = tempDir();
    const file = join(dir, "app.db");
    shares.push(acquireInstanceLock(file, { module: "test", ttlMs: 300, heartbeatMs: 100 }));
    const db = await setUp({ file });
    expect(module.health!(db)).toEqual({ ok: true });

    holdForeignLock(file);
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(module.health!(db)).toMatchObject({ ok: false, restartRequired: true });
    await module.teardown!(db);
  });
});
