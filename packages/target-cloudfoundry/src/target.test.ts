import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsError } from "@michaelthielemann/kestrel-ops";
import { cloudFoundryTarget, createTarget, type CloudFoundryTarget } from "./index.ts";
import { FakeCloudFoundry } from "./fakeCloudFoundry.fixture.ts";

const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };
const WEB = { name: "site-web", guid: "c5e9d1b4-73a2-4f08-b6de-91a7c0f2e3d5" };
const SECRET = "vars-value-3c9e-never-in-argv";
const OTHER_SECRET = "second-value-58ab-never-in-argv";

const MANIFEST = `---
applications:
- name: site-web
  memory: 64M
  env:
    UPSTREAM: ((upstream_host))
- name: site-api
  memory: 1024M
  instances: 1
  health-check-type: process
  env:
    NODE_ENV: production
    STORAGE_SECRET: ((storage_secret))
    SESSION_SECRET: ((session_secret))
`;

let cf: FakeCloudFoundry;
let root: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  cf.addApp({ ...API, env: { STORAGE_SECRET: SECRET, NODE_ENV: "production" } });
  cf.addApp({ ...WEB });
  root = mkdtempSync(join(tmpdir(), "kestrel-cf-target-"));
});

afterEach(async () => {
  await cf.close();
  rmSync(root, { recursive: true, force: true });
});

function target(config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev", ...config }, { root, clock: Date.now }, { env: cf.env({ ...process.env, ...env }), pollMs: 5 });
}

async function failure(promise: Promise<unknown>): Promise<OpsError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpsError) return error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function namesOtherApp(): string[][] {
  return cf.calls.filter((argv) => argv.some((arg) => arg.includes(WEB.name) || arg.includes(WEB.guid)));
}

describe("Cloud Foundry target", { timeout: 60_000 }, () => {
  it("is created from its block in kestrel.environments.json and promotes, since an app instance starts on an empty disk", async () => {
    const created = await createTarget({ app: API.name, org: "example-org", space: "dev" }, { root, clock: Date.now });
    expect(created.transport).toBe("promote");
  });

  it("reads a started app with one running instance and a stopped app with no instance", async () => {
    const t = await target();
    expect(await t.status()).toEqual({ state: "started", instances: 1 });
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    app.state = "STOPPED";
    app.running = 0;
    app.ready = 0;
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
  });

  it("counts a starting instance as running", async () => {
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    app.ready = 0;
    expect(await (await target()).status()).toEqual({ state: "started", instances: 1 });
  });

  it("refuses with exit 1 an app scaled to more than one instance, naming the count", async () => {
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    app.instances = 2;
    app.running = 2;
    const t = await target();
    const error = await failure(t.status());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("2 instances");
    expect(error.message).toContain(`cf scale ${API.name} -i 1`);
    await failure(t.stop());
    expect(cf.calls.some((argv) => argv[0] === "stop")).toBe(false);
  });

  it("refuses with exit 1 a stopped app scaled to more than one instance", async () => {
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    Object.assign(app, { state: "STOPPED", instances: 3, running: 0, ready: 0 });
    expect((await failure((await target()).status())).exitCode).toBe(1);
  });

  it("refuses with exit 1 while a rolling deployment of the app is active", async () => {
    cf.activeDeployments.add(API.guid);
    const t = await target();
    const error = await failure(t.status());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("deployment");
    await failure(t.start());
    expect(cf.calls.some((argv) => argv[0] === "start")).toBe(false);
  });

  it("stops and starts the app, waits until an instance runs, and never names another app", async () => {
    const t = await target();
    const stopped = await t.stop();
    expect(stopped.stoppedAt).toBeGreaterThan(0);
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
    await t.start();
    expect(await t.waitReady(5000)).toBe(true);
    expect(cf.calls).toContainEqual(["stop", API.name]);
    expect(cf.calls).toContainEqual(["start", API.name]);
    expect(namesOtherApp()).toEqual([]);
    expect(cf.colors.every((color) => color === "false")).toBe(true);
  });

  it("answers false when no instance runs before the timeout", async () => {
    const t = await target();
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    app.ready = 0;
    expect(await t.waitReady(50)).toBe(false);
  });

  it("checks the readiness URL once an instance runs", async () => {
    const { createServer } = await import("node:http");
    let ready = false;
    const server = createServer((_request, response) => {
      response.statusCode = ready ? 200 : 503;
      response.end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const t = await target({ readyUrl: `http://127.0.0.1:${port}/api/ready` });
      expect(await t.waitReady(60)).toBe(false);
      ready = true;
      expect(await t.waitReady(5000)).toBe(true);
    } finally {
      server.close();
    }
  });

  it("ends with exit 1 naming the app when cf start fails", async () => {
    cf.failures.set("start", 1);
    const t = await target();
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    Object.assign(app, { state: "STOPPED", running: 0, ready: 0 });
    const error = await failure(t.start());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(`cf start ${API.name}`);
  });

  it("refuses with exit 2 when cf targets another org or space, or is not logged in, and never acts", async () => {
    cf.space = "prod";
    const wrong = await failure((await target()).stop());
    expect(wrong.exitCode).toBe(2);
    expect(wrong.message).toContain("cf target -o example-org -s dev");
    cf.space = "dev";
    cf.loggedIn = false;
    const loggedOut = await failure((await target()).status());
    expect(loggedOut.exitCode).toBe(2);
    expect(loggedOut.message).toContain("cf login");
    expect(cf.calls.some((argv) => argv[0] === "stop")).toBe(false);
  });

  it("refuses with exit 2 an app the space does not hold", async () => {
    const error = await failure((await target({ app: "missing-app" })).status());
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("missing-app");
  });

  it("ends with exit 2 when cf is not on PATH", async () => {
    const t = await cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev" }, { root, clock: Date.now }, { env: { PATH: root }, pollMs: 5 });
    const error = await failure(t.status());
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("cf");
  });

  it("rejects an invalid target block with exit 2", async () => {
    const error = await failure(Promise.resolve().then(() => cloudFoundryTarget({ app: API.name, org: "example-org" }, { root, clock: Date.now })));
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain("space");
  });

  it("describes the app by guid, droplet and the names of its variables, never their values, and the installed runtime versions", async () => {
    mkdirSync(join(root, "node_modules", "@michaelthielemann", "kestrel-replication-sqlite"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@michaelthielemann/kestrel-replication-sqlite": "^6.0.0" } }));
    writeFileSync(join(root, "node_modules", "@michaelthielemann", "kestrel-replication-sqlite", "package.json"), JSON.stringify({ name: "@michaelthielemann/kestrel-replication-sqlite", version: "6.0.0" }));
    const facts = await (await target()).describe();
    expect(facts).toMatchObject({ kind: "cloudfoundry", app: API.name, appGuid: API.guid, org: "example-org", space: "dev", droplet: "d7c1a3e0-0000-4000-8000-000000000001", envNames: ["NODE_ENV", "STORAGE_SECRET"], packages: { "@michaelthielemann/kestrel-replication-sqlite": "6.0.0" } });
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(namesOtherApp()).toEqual([]);
  });

  it("shows stop and crash events and teardown error lines as evidence for a stop without a seal", async () => {
    const app = cf.apps.get(API.name);
    if (app === undefined) throw new Error("no app");
    app.events = [{ type: "audit.app.stop", created_at: "2026-11-14T10:00:00Z" }, { type: "audit.app.update", created_at: "2026-11-14T09:00:00Z" }, { type: "app.crash", created_at: "2026-11-14T08:00:00Z" }];
    app.logs = ["2026-11-14T10:00:01Z [APP/PROC/WEB/0] OUT listening", "2026-11-14T10:00:02Z [APP/PROC/WEB/0] ERR replication: teardown sync failed: timeout", "2026-11-14T10:00:03Z [CELL/0] OUT Stopping instance"];
    const evidence = await (await target()).stopEvidence?.();
    expect(evidence).toEqual(["2026-11-14T10:00:00Z audit.app.stop", "2026-11-14T08:00:00Z app.crash", "2026-11-14T10:00:02Z [APP/PROC/WEB/0] ERR replication: teardown sync failed: timeout"]);
  });

  describe("manifest", () => {
    beforeEach(() => {
      writeFileSync(join(root, "manifest.yml"), MANIFEST);
      const app = cf.apps.get(API.name);
      if (app !== undefined) Object.assign(app, { state: "STOPPED", running: 0, ready: 0 });
    });

    const vars = { storage_secret: { env: "APP_STORAGE_SECRET" }, session_secret: { command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(OTHER_SECRET)} + "\\n")`] }, upstream_host: { env: "UPSTREAM_HOST" } };

    it("applies only the app's entry with its variables from a file readable only by this user, removed afterwards, and never passes a value in argv", async () => {
      const t = await target({ manifest: "manifest.yml", vars }, { APP_STORAGE_SECRET: SECRET, UPSTREAM_HOST: "upstream-host-value" });
      await t.applyManifest();
      expect(cf.applied).toHaveLength(1);
      const [applied] = cf.applied;
      if (applied === undefined) throw new Error("nothing applied");
      expect(applied.varsMode).toBe(0o600);
      expect(JSON.parse(applied.vars)).toEqual({ storage_secret: SECRET, session_secret: OTHER_SECRET });
      expect(applied.manifest).toContain("((storage_secret))");
      expect(applied.manifest).toContain(API.name);
      expect(applied.manifest).not.toContain(WEB.name);
      expect(applied.manifest).not.toContain("upstream");
      expect(existsSync(applied.varsFile)).toBe(false);
      for (const argv of cf.calls) for (const arg of argv) for (const secret of [SECRET, OTHER_SECRET, "upstream-host-value"]) expect(arg).not.toContain(secret);
      expect(namesOtherApp()).toEqual([]);
      expect(cf.calls.some((argv) => argv[0] === "set-env")).toBe(false);
    });

    it("removes the variables file also when cf apply-manifest fails, and ends with exit 1", async () => {
      cf.failures.set("apply-manifest", 1);
      const before = readdirSync(tmpdir()).filter((name) => name.startsWith("kestrel-cf-vars-"));
      const t = await target({ manifest: "manifest.yml", vars }, { APP_STORAGE_SECRET: SECRET });
      const error = await failure(t.applyManifest());
      expect(error.exitCode).toBe(1);
      expect(error.message).not.toContain(SECRET);
      const call = cf.calls.find((argv) => argv[0] === "apply-manifest") ?? [];
      const varsFile = call[call.indexOf("--vars-file") + 1] ?? "";
      expect(varsFile).not.toBe("");
      expect(existsSync(varsFile)).toBe(false);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith("kestrel-cf-vars-"))).toEqual(before);
    });

    it("refuses with exit 1 while the app runs", async () => {
      const app = cf.apps.get(API.name);
      if (app !== undefined) Object.assign(app, { state: "STARTED", running: 1, ready: 1 });
      const error = await failure((await target({ manifest: "manifest.yml", vars }, { APP_STORAGE_SECRET: SECRET })).applyManifest());
      expect(error.exitCode).toBe(1);
      expect(cf.applied).toEqual([]);
    });

    it("refuses with exit 2 a variable without a source and a manifest without the app, before it calls cf", async () => {
      const missing = await failure((await target({ manifest: "manifest.yml", vars: { storage_secret: { env: "APP_STORAGE_SECRET" } } }, { APP_STORAGE_SECRET: SECRET })).applyManifest());
      expect(missing.exitCode).toBe(2);
      expect(missing.message).toContain("((session_secret))");
      writeFileSync(join(root, "other.yml"), "applications:\n- name: site-web\n");
      const absent = await failure((await target({ manifest: "other.yml", vars }, { APP_STORAGE_SECRET: SECRET })).applyManifest());
      expect(absent.exitCode).toBe(2);
      expect(absent.message).toContain(API.name);
      expect(cf.calls.some((argv) => argv[0] === "apply-manifest")).toBe(false);
    });

    it("sets a droplet only while the app is stopped", async () => {
      const t = await target();
      await t.setDroplet("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f");
      expect(cf.calls).toContainEqual(["set-droplet", API.name, "0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f"]);
      const app = cf.apps.get(API.name);
      if (app !== undefined) Object.assign(app, { state: "STARTED", running: 1, ready: 1 });
      expect((await failure(t.setDroplet("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f"))).exitCode).toBe(1);
      expect((await failure(t.setDroplet("not a guid"))).exitCode).toBe(2);
    });
  });
});

describe("source of the Cloud Foundry target", () => {
  it("never sets an environment variable through cf set-env, which would put the value into argv", () => {
    const dir = import.meta.dirname;
    for (const file of readdirSync(dir).filter((name) => !name.endsWith(".test.ts") && !name.endsWith(".fixture.ts"))) expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/set-env|setenv/i);
  });
});
