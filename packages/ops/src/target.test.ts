import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { writeBundle } from "./bundle.ts";
import { createHarness, LOCATION } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { probeProtection } from "./status.ts";
import { instanceLockSidecar, localTarget } from "./target.ts";
import { stateDir } from "./workspace.ts";
import type { ObjectStore } from "./store.ts";

describe("local target", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kestrel-ops-local-"));
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "server.mjs"), "process.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("starts the app in the background, reports one instance, stops it with SIGTERM and passes on only its own environment", async () => {
    writeFileSync(join(root, "app", "server.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('env.json', JSON.stringify(process.env));\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n");
    const target = await localTarget({ dir: "app", database: "data/kestrel.db", command: [process.execPath, "server.mjs"], env: { APP_MODE: "rehearsal" }, disk: "persistent" }, { root, clock: Date.now });
    expect(await target.status()).toEqual({ state: "stopped", instances: 0 });
    await target.start();
    expect(await target.status()).toEqual({ state: "started", instances: 1 });
    expect(await target.waitReady(5000)).toBe(true);
    for (let i = 0; i < 100 && !existsSync(join(root, "app", "env.json")); i++) await new Promise((r) => setTimeout(r, 20));
    const env = boundaryCast<Record<string, string>>(JSON.parse(readFileSync(join(root, "app", "env.json"), "utf8")), "json");
    expect(env.APP_MODE).toBe("rehearsal");
    expect(Object.keys(env).filter((k) => k !== "APP_MODE" && k !== "PATH" && !k.startsWith("NODE_") && k !== "_" && k !== "PWD" && k !== "SHLVL")).toEqual([]);
    await expect(target.start()).rejects.toThrow(/already running/);
    await target.stop();
    expect(await target.status()).toEqual({ state: "stopped", instances: 0 });
    expect(target.transport).toBe("file");
  });

  it("places a restored database as the replication restore marker and never writes or removes the instance-lock sidecar", async () => {
    const target = await localTarget({ dir: "app", database: "data/kestrel.db", command: [process.execPath, "server.mjs"], disk: "persistent" }, { root, clock: Date.now });
    const database = join(root, "app", "data", "kestrel.db");
    mkdirSync(join(root, "app", "data"));
    writeFileSync(instanceLockSidecar(database), "held by an earlier process");
    const restored = join(root, "restored.db");
    const db = new DatabaseSync(restored);
    db.exec(`CREATE TABLE pages ("id" TEXT PRIMARY KEY)`);
    db.close();
    await target.installDatabase?.(restored);
    expect(readFileSync(`${database}.restore`)).toEqual(readFileSync(restored));
    expect(readFileSync(instanceLockSidecar(database), "utf8")).toBe("held by an earlier process");
    expect(instanceLockSidecar(database)).toBe(`${database}.instance`);
  });

  it("removes the database but not the sidecar before each start on an ephemeral disk", async () => {
    const target = await localTarget({ dir: "app", database: "kestrel.db", command: [process.execPath, "server.mjs"], disk: "ephemeral" }, { root, clock: Date.now });
    const database = join(root, "app", "kestrel.db");
    for (const suffix of ["", "-wal", "-shm"]) writeFileSync(database + suffix, "x");
    await target.start();
    await target.stop();
    expect(["", "-wal", "-shm"].map((s) => existsSync(database + s))).toEqual([false, false, false]);
    expect(target.transport).toBe("promote");
  });

  it("rejects an incomplete target block as a configuration error", async () => {
    await expect(async () => localTarget({ dir: "app", database: "x.db", command: [], disk: "persistent" }, { root, clock: Date.now })).rejects.toThrow(/command must be a non-empty list/);
    await expect(async () => localTarget({ dir: "app", database: "x.db", command: ["node"], disk: "tmpfs" }, { root, clock: Date.now })).rejects.toThrow(/disk must be/);
  });
});

describe("restore --to local", () => {
  it("writes the backup's database without sessions and with its originals, never an instance-lock sidecar", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("local")) });
    const out = join(h.root, "copy");
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      const result = await h.run(["restore", "--to", "local", out, "--backup", String(backup.json.id), "--with-media", "--yes", "--json"]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ sessionsDeleted: 1, originals: 3 });
      const db = new DatabaseSync(join(out, "kestrel.db"), { readOnly: true });
      expect(db.prepare(`SELECT count(*) AS n FROM authn_sessions`).get()).toEqual({ n: 0 });
      expect(db.prepare(`SELECT count(*) AS n FROM pages`).get()).toEqual({ n: 3 });
      db.close();
      expect(readFileSync(join(out, "blobs", "media", "m1", "harbour.jpg"), "utf8")).toBe("harbour image bytes");
      expect(existsSync(join(out, "kestrel.db.instance"))).toBe(false);

      const latest = await h.run(["restore", "--to", "local", join(h.root, "latest"), "--latest", "--keep-sessions", "--json"]);
      expect(latest.code).toBe(0);
      expect(latest.json).toMatchObject({ sessionsDeleted: 0 });
      expect((await h.run(["restore", "--to", "local", out, "--latest"])).code).toBe(1);
      expect((await h.run(["restore", "--to", "local", join(h.root, "x")])).code).toBe(2);
      const media = join(h.root, "media");
      const refused = await h.run(["restore", "--to", "local", media, "--latest", "--with-media", "--yes"]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain("--with-media needs --backup <id>");
      expect(existsSync(join(media, "kestrel.db"))).toBe(false);
      expect((await h.run(["restore", "--to", "local", media, "--backup", String(backup.json.id), "--with-media", "--yes"])).code).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});

describe("status", () => {
  it("reports the target, the replica head and the backups, and flags a backup location inside an app prefix", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("status")) });
    try {
      await h.app.start();
      await h.app.seed();
      await h.run(["backup", "create"]);
      const ok = await h.run(["status", "--json"]);
      expect(ok.stderr).toBe("");
      expect(ok.code).toBe(0);
      expect(ok.json).toMatchObject({ target: { state: "started", instances: 1 }, replica: { runtime: "6.0.0", sealed: false }, protectedFromApp: "unknown", problems: [] });
      expect(ok.json.backups).toHaveLength(1);
      const file = join(h.root, "kestrel.environments.json");
      writeFileSync(file, readFileSync(file, "utf8").replace(`"prefix": "${LOCATION}"`, `"prefix": "media/backups/"`));
      const bad = await h.run(["status"]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("the backup location media/backups/ overlaps the app prefix media/");
    } finally {
      await h.dispose();
    }
  });

  it("calls the backups protected only when the app's credentials are denied a delete", async () => {
    const tool = memoryStore(new MemoryBucket("protect"));
    const denied: ObjectStore = { ...tool, delete: async () => Promise.reject(Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } })) };
    expect(await probeProtection(tool, denied, LOCATION, "r1")).toBe("yes");
    expect(await probeProtection(tool, tool, LOCATION, "r2")).toBe("no");
    expect(await probeProtection(tool, null, LOCATION, "r3")).toBe("unknown");
  });

  it("probes the protection in the separate backup bucket with the app's credentials", async () => {
    const app = memoryStore(new MemoryBucket("app-protect"));
    const backups = memoryStore(new MemoryBucket("backup-protect"));
    const h = createHarness({ store: app });
    h.editEnvironments((file) => {
      const prod = file.environments.prod ?? {};
      prod.backups = { prefix: LOCATION, storage: { bucket: "backup-protect" } };
      prod.app = { ...(prod.app ?? {}), credentials: { accessKeyId: { env: "OPS_ACCESS_KEY" }, secretAccessKey: { env: "OPS_SECRET_KEY" } } };
    });
    try {
      await h.app.start();
      await h.app.seed();
      const report = await h.run(["status", "--json"], { stores: (config) => (config.bucket === "backup-protect" ? backups : app) });
      expect(report.json).toMatchObject({ protectedFromApp: "no", problems: ["the app's credentials can delete backups"] });
    } finally {
      await h.dispose();
    }
  });

  it("rejects a missing or invalid environments file and an unknown environment with exit 2", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("config")) });
    try {
      expect((await h.run(["status", "--env", "staging"])).stderr).toContain("unknown environment staging (prod)");
      expect((await h.run(["backup", "frobnicate"])).code).toBe(2);
      expect((await h.run(["backup", "create", "--bogus"])).stderr).toContain("unknown option --bogus");
      writeFileSync(join(h.root, "kestrel.environments.json"), JSON.stringify({ environments: { prod: { target: { adapter: "fake" } } } }));
      const invalid = await h.run(["status"]);
      expect(invalid.code).toBe(2);
      expect(invalid.stderr).toContain("kestrel.environments.json: environments.prod.storage");
      rmSync(join(h.root, "kestrel.environments.json"));
      expect((await h.run(["status"])).code).toBe(2);
    } finally {
      await h.dispose();
    }
  });
});

describe("workspace", () => {
  it("lives under XDG_STATE_HOME on Linux and Application Support on macOS", () => {
    expect(stateDir({ XDG_STATE_HOME: "/state" }, "linux", "/home/op")).toBe("/state/kestrel");
    expect(stateDir({}, "linux", "/home/op")).toBe("/home/op/.local/state/kestrel");
    expect(stateDir({}, "darwin", "/Users/op")).toBe("/Users/op/Library/Application Support/kestrel");
  });
});

describe("bundle", () => {
  it("runs from a directory whose path holds spaces and non-ASCII letters", () => {
    const base = mkdtempSync(join(tmpdir(), "kestrel-ops-bundle-path-"));
    const project = join(base, "Sites and Übungen");
    try {
      const self = join(project, "node_modules", "@michaelthielemann");
      mkdirSync(self, { recursive: true });
      symlinkSync(join(import.meta.dirname, ".."), join(self, "kestrel-ops"));
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "site", dependencies: { "@michaelthielemann/kestrel-ops": "5.8.1" } }));
      writeFileSync(join(project, "kestrel.environments.json"), JSON.stringify({ environments: {} }));
      const { dir } = writeBundle(project, project, {}, () => 1);
      const stub = join(base, "stub.mjs");
      writeFileSync(stub, `import { existsSync } from "node:fs";\nexport const terminalPrompt = () => undefined;\nexport async function runOps(argv, options) { process.stdout.write(JSON.stringify({ cwd: options.cwd, found: existsSync(options.cwd + "/kestrel.environments.json") })); return 0; }\n`);
      const runner = join(dir, "run.mjs");
      writeFileSync(runner, readFileSync(runner, "utf8").replace('"@michaelthielemann/kestrel-ops/run"', JSON.stringify(pathToFileURL(stub).href)));
      const out = execFileSync(process.execPath, [runner, "status"], { encoding: "utf8" });
      expect(JSON.parse(out)).toEqual({ cwd: `${dir}/`, found: true });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 60_000);

  it("writes run.mjs, bundle.json, the environments file and kestrel-ops with the packages it needs", () => {
    const project = mkdtempSync(join(tmpdir(), "kestrel-ops-bundle-"));
    try {
      const self = join(project, "node_modules", "@michaelthielemann");
      mkdirSync(self, { recursive: true });
      symlinkSync(join(import.meta.dirname, ".."), join(self, "kestrel-ops"));
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "site", dependencies: { "@michaelthielemann/kestrel-ops": "5.8.1" } }));
      writeFileSync(join(project, "kestrel.environments.json"), JSON.stringify({ environments: {} }));
      writeFileSync(join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const { dir, packages } = writeBundle(project, project, { readyPath: "/ready" }, () => 1);
      expect(Object.keys(packages)).toEqual(expect.arrayContaining(["@michaelthielemann/kestrel-ops", "@michaelthielemann/kestrel-replication-sqlite", "@michaelthielemann/kestrel-blobstore-s3", "@aws-sdk/client-s3", "zod"]));
      expect(readFileSync(join(dir, "run.mjs"), "utf8")).toContain('const { runOps, terminalPrompt } = await import("@michaelthielemann/kestrel-ops/run");');
      const info: unknown = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8"));
      expect(info).toMatchObject({ schema: "kestrel-ops/bundle@1", hostFacts: { readyPath: "/ready" } });
      expect(Reflect.get(Object(info), "lockfileSha256")).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(join(dir, "kestrel.environments.json"))).toBe(true);
      expect(existsSync(join(dir, "node_modules", "@michaelthielemann", "kestrel-ops", "package.json"))).toBe(true);
      expect(existsSync(join(dir, "node_modules", "@michaelthielemann", "kestrel-ops", "node_modules"))).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});
