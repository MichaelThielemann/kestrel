import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { s3Store, type S3Store } from "@michaelthielemann/kestrel-ops";
import { FakeCloudFoundry, type FakeCfApp } from "./src/fakeCloudFoundry.fixture.ts";
import { StandInApp, type StandInPrefixes } from "./src/standInApp.fixture.ts";

const endpoint = process.env.KESTREL_S3_ENDPOINT;
const bucket = process.env.KESTREL_S3_BUCKET ?? "kestrel-test";
const accessKeyId = process.env.KESTREL_S3_ACCESS_KEY ?? "";
const secretAccessKey = process.env.KESTREL_S3_SECRET_KEY ?? "";

const REPO = join(import.meta.dirname, "..", "..");
const CLI = join(REPO, "packages", "cli", "src", "cli.ts");
const LOCATION = "kestrel-backups/";
const PREFIXES: StandInPrefixes = { replica: "database/", media: "media/", delivery: "www/", derived: "media-variants/" };
const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };
const WEB = { name: "site-web", guid: "c5e9d1b4-73a2-4f08-b6de-91a7c0f2e3d5" };
const GENERATION = /^gen\/(\d{8}T\d{6}Z[^/]*)\//;

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (data: Uint8Array | null): string => new TextDecoder().decode(data ?? new Uint8Array());

function backupRows(data: Uint8Array): Record<string, unknown[]> {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-cf-rows-"));
  try {
    const file = join(dir, "db.sqlite");
    writeFileSync(file, data);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const out: Record<string, unknown[]> = {};
      for (const table of ["pages", "media_items", "authn_users", "audit_entries", "mfa_factors", "authn_sessions"]) out[table] = db.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all();
      return out;
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function generations(store: S3Store): Promise<string[]> {
  const names = new Set<string>();
  for (const info of await store.list(`${PREFIXES.replica}gen/`)) {
    const m = GENERATION.exec(info.key.slice(PREFIXES.replica.length));
    if (m?.[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

describe.skipIf(!endpoint)("kestrel backup, restore and status on a Cloud Foundry app against MinIO", () => {
  let root: string;
  let cf: FakeCloudFoundry;
  let store: S3Store;
  let app: StandInApp;
  let api: FakeCfApp;
  const outputs: string[] = [];
  const generationsAtStart: string[][] = [];
  const generationsAtStop: string[][] = [];
  let storagePrefix = "";

  function configureTarget(extra: Record<string, unknown>): void {
    const environments = {
      environments: {
        dev: {
          production: true,
          target: { adapter: "@michaelthielemann/kestrel-target-cloudfoundry", app: API.name, org: "example-org", space: "dev", ...extra },
          storage: { bucket, prefix: storagePrefix, endpoint, region: "us-east-1", forcePathStyle: true },
          app: { replicaPrefix: PREFIXES.replica, mediaPrefix: PREFIXES.media, deliveryPrefix: PREFIXES.delivery, derivedPrefixes: [PREFIXES.derived] },
          backups: { prefix: LOCATION },
        },
      },
    };
    writeFileSync(join(root, "kestrel.environments.json"), JSON.stringify(environments, null, 2));
  }

  beforeEach(async () => {
    const prefix = `cf-e2e/${Date.now()}-${randomBytes(4).toString("hex")}/`;
    root = mkdtempSync(join(tmpdir(), "kestrel-cf-e2e-"));
    store = s3Store({ bucket, prefix, endpoint, region: "us-east-1", forcePathStyle: true, accessKeyId, secretAccessKey });
    app = new StandInApp(store, PREFIXES);
    cf = new FakeCloudFoundry();
    await cf.listen();
    api = cf.addApp({ ...API, env: { STORAGE_SECRET: secretAccessKey } });
    cf.addApp({ ...WEB });
    cf.hooks = {
      start: async (started) => {
        if (started.name !== API.name) throw new Error(`started ${started.name}`);
        generationsAtStart.push(await generations(store));
        await app.start();
      },
      stop: async (stopped) => {
        if (stopped.name !== API.name) throw new Error(`stopped ${stopped.name}`);
        await app.stop();
        generationsAtStop.push(await generations(store));
      },
    };
    const scope = join(root, "node_modules", "@michaelthielemann");
    mkdirSync(join(scope, "kestrel-replication-sqlite"), { recursive: true });
    symlinkSync(join(REPO, "packages", "ops"), join(scope, "kestrel-ops"), "dir");
    symlinkSync(join(REPO, "packages", "target-cloudfoundry"), join(scope, "kestrel-target-cloudfoundry"), "dir");
    writeFileSync(join(scope, "kestrel-replication-sqlite", "package.json"), JSON.stringify({ name: "@michaelthielemann/kestrel-replication-sqlite", version: "6.0.0" }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "example-site", private: true, dependencies: { "@michaelthielemann/kestrel-replication-sqlite": "^6.0.0" } }));
    storagePrefix = prefix;
    configureTarget({});
  });

  afterEach(async () => {
    await cf.idle();
    await app.dispose();
    await cf.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function kestrel(args: string[]): Promise<Outcome> {
    const env = cf.env({ ...process.env, AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, XDG_STATE_HOME: join(root, "state"), NODE_PATH: "" });
    return new Promise((resolve) => {
      execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", CLI, ...args], { cwd: root, env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        outputs.push(stdout, stderr);
        const start = stdout.lastIndexOf('\n{\n  "schema"');
        const text = start >= 0 ? stdout.slice(start + 1) : stdout.startsWith('{\n  "schema"') ? stdout : "";
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr, json: text === "" ? {} : boundaryCast<Record<string, unknown>>(JSON.parse(text), "json") });
      });
    });
  }

  function answers(values: Record<string, string>): string {
    const file = join(root, `answers-${randomBytes(3).toString("hex")}.json`);
    writeFileSync(file, JSON.stringify(values));
    return file;
  }

  it("backs up with --freeze, restores by promoting while the app is stopped, and a second restore changes nothing, touching only the node app", async () => {
    await app.start();
    await app.seed();

    const before = await kestrel(["status", "--json"]);
    expect(before.stderr).toBe("");
    expect(before.code).toBe(0);
    expect(before.json).toMatchObject({ target: { state: "started", instances: 1 } });

    const created = await kestrel(["backup", "create", "--freeze", "--json"]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    const id = String(created.json.id);
    expect(created.json.manifest).toMatchObject({ kind: "manual", frozen: true, source: { seal: "sealed" }, blobs: { count: 3 }, site: { count: 4 }, target: { kind: "cloudfoundry", app: API.name, appGuid: API.guid, revision: { guid: "e2a4c6f8-0000-4000-8000-000000000003", version: 3 }, envNames: ["STORAGE_SECRET"] } });
    expect(app.running).toBe(true);
    expect(api.state).toBe("STARTED");
    expect(cf.actions).toEqual([{ app: API.name, space: "dev", action: "stop" }, { app: API.name, space: "dev", action: "start" }]);

    expect((await kestrel(["backup", "verify", id])).code).toBe(0);
    const listed = await kestrel(["backup", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.stringify(listed.json)).toContain(id);

    await app.deleteMedia("m1");
    app.run(`UPDATE pages SET "title" = 'About us' WHERE "id" = 'about'`);
    app.run(`INSERT INTO pages VALUES ('news', 'News', 'Fresh')`);
    app.run(`DELETE FROM pages WHERE "id" = 'contact'`);
    const newer = await app.upload("m4", "later.png", encode("uploaded after the backup"));
    app.run(`INSERT INTO authn_sessions VALUES ('s2', 'u2', 9999999999999, 2)`);
    await app.export();
    await app.sync();

    const stopsBefore = generationsAtStop.length;
    const startsBefore = generationsAtStart.length;
    const restored = await kestrel(["restore", "--backup", id, "--yes", "--answers", answers({ "access-changes": "accept" }), "--json"]);
    expect(restored.stderr).toBe("");
    expect(restored.code).toBe(0);
    expect(restored.json).toMatchObject({ noop: false, originalsRestored: [`${PREFIXES.media}m1/harbour.jpg`], newerOriginals: [newer], acknowledgement: "applied", sessionsDeleted: 1 });
    const promoted = String(Reflect.get(Object(restored.json.promoted), "generation"));
    expect(generationsAtStop.slice(stopsBefore).flat()).not.toContain(promoted);
    expect(generationsAtStart.slice(startsBefore).at(-1)).toContain(promoted);
    expect(app.restoredFrom).toBe(promoted);
    expect(app.acknowledged).toBe(promoted);

    const expected = backupRows((await store.get(`${LOCATION}backups/${id}/db.sqlite`)) ?? new Uint8Array());
    for (const table of ["pages", "media_items", "authn_users", "audit_entries", "mfa_factors"]) expect(app.rows(table), table).toEqual(expected[table]);
    expect(app.rows("authn_sessions")).toEqual([]);
    expect(decode(await store.get(`${PREFIXES.media}m1/harbour.jpg`))).toBe("harbour image bytes");
    expect(await store.head(newer)).not.toBeNull();
    expect(decode(await store.get(`${PREFIXES.delivery}contact/index.html`))).toContain("Contact");
    expect(await store.head(`${PREFIXES.delivery}news/index.html`)).toBeNull();

    const again = await kestrel(["restore", "--backup", id, "--yes", "--answers", answers({ "access-changes": "accept" }), "--json"]);
    expect(again.stderr).toBe("");
    expect(again.code).toBe(0);
    expect(again.json).toMatchObject({ noop: true, safetyBackup: null, promoted: null });
    expect(api.state).toBe("STARTED");

    const after = await kestrel(["status", "--json"]);
    expect(after.code).toBe(0);
    expect(after.json).toMatchObject({ target: { state: "started", instances: 1 } });

    expect(cf.calls.filter((argv) => argv.some((arg) => arg.includes(WEB.name) || arg.includes(WEB.guid)))).toEqual([]);
    for (const argv of cf.calls) for (const arg of argv) expect(arg).not.toContain(secretAccessKey);
    for (const text of outputs) expect(text).not.toContain(secretAccessKey);
  }, 300_000);

  it("finishes a frozen backup through a failed status read after the stop and starts the app again", async () => {
    await app.start();
    await app.seed();
    const stop = cf.hooks.stop;
    cf.hooks.stop = async (stopped) => {
      await stop?.(stopped);
      cf.failNext.set("curl", 1);
    };
    const created = await kestrel(["backup", "create", "--freeze", "--json"]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(created.json.manifest).toMatchObject({ frozen: true, source: { seal: "sealed" } });
    expect(cf.actions.map((action) => action.action)).toEqual(["stop", "start"]);
    expect(api.state).toBe("STARTED");
    expect(app.running).toBe(true);
  }, 120_000);

  it("backs up a sealed replica with --freeze when the platform lists the shutting-down instance as DOWN and the seal lands seconds after the stop request", async () => {
    await app.start();
    await app.seed();
    cf.stoppingState = "DOWN";
    cf.stopLag = 0;
    configureTarget({ stopGraceSeconds: 12 });
    const stop = cf.hooks.stop;
    cf.hooks.stop = async (stopped) => {
      await new Promise((done) => setTimeout(done, 8000));
      await stop?.(stopped);
    };
    const created = await kestrel(["backup", "create", "--freeze", "--json"]);
    expect(created.stderr).toBe("");
    expect(created.code).toBe(0);
    expect(created.json.manifest).toMatchObject({ frozen: true, source: { seal: "sealed" } });
    expect(cf.actions.map((action) => action.action)).toEqual(["stop", "start"]);
    expect(app.running).toBe(true);
  }, 120_000);

  it("refuses with exit 1 an app scaled to two instances before it stops anything", async () => {
    await app.start();
    await app.seed();
    api.instances = 2;
    const status = await kestrel(["status"]);
    expect(status.code).toBe(1);
    expect(status.stderr).toContain("2 instances");
    const created = await kestrel(["backup", "create", "--freeze"]);
    expect(created.code).toBe(1);
    expect(created.stderr).toContain(`cf scale ${API.name} -i 1`);
    const live = await kestrel(["backup", "create", "--kind", "scheduled"]);
    expect(live.code).toBe(1);
    expect(live.stderr).toContain("2 instances");
    expect(cf.actions).toEqual([]);
    expect(app.running).toBe(true);
  }, 120_000);
});
