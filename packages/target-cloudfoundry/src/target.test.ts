import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsError } from "@michaelthielemann/kestrel-ops";
import { cloudFoundryTarget, createTarget, type CloudFoundryOptions, type CloudFoundryTarget } from "./index.ts";
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

function target(config: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}, options: CloudFoundryOptions = {}): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev", ...config }, { root, clock: Date.now }, { env: cf.env({ ...process.env, ...env }), pollMs: 5, ...options });
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

async function signalDuringUse(signal: NodeJS.Signals, host: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; temp: string }> {
  const temp = join(root, "temp");
  mkdirSync(temp);
  const script = join(root, "signal-during-apply.mjs");
  writeFileSync(script, `${host}import { withManifestFiles } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "manifest.ts")).href)};
await withManifestFiles("applications: []", { storage_secret: ${JSON.stringify(SECRET)} }, async (manifestFile) => {
  process.stdout.write(manifestFile);
  await new Promise((done) => setTimeout(done, 60_000));
});
`);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", script], { env: { ...process.env, TMPDIR: temp }, stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on("exit", (code, received) => done({ code, signal: received })));
  await new Promise<void>((done) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      done();
    });
  });
  child.kill(signal);
  return { ...(await ended), stdout, temp };
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
    const app = cf.app(API.name);
    app.state = "STOPPED";
    app.running = 0;
    app.ready = 0;
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
  });

  it("counts a starting instance as running", async () => {
    const app = cf.app(API.name);
    app.ready = 0;
    expect(await (await target()).status()).toEqual({ state: "started", instances: 1 });
  });

  it("refuses with exit 1 an app scaled to more than one instance, naming the count", async () => {
    const app = cf.app(API.name);
    app.instances = 2;
    app.running = 2;
    const t = await target();
    const error = await failure(t.status());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("2 instances");
    expect(error.message).toContain(`cf scale ${API.name} -i 1`);
    await failure(t.stop());
    expect(cf.actions).toEqual([]);
  });

  it("refuses with exit 1 a stopped app scaled to more than one instance", async () => {
    const app = cf.app(API.name);
    Object.assign(app, { state: "STOPPED", instances: 3, running: 0, ready: 0 });
    expect((await failure((await target()).status())).exitCode).toBe(1);
  });

  it("refuses with exit 1 a started app scaled to no instance before anything is stopped, naming how to scale or stop it", async () => {
    Object.assign(cf.app(API.name), { instances: 0, running: 0, ready: 0 });
    const t = await target();
    const error = await failure(t.status());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("0 instances");
    expect(error.message).toContain(`cf scale ${API.name} -i 1`);
    expect(error.message).toContain(`cf stop ${API.name}`);
    await failure(t.stop());
    expect(cf.actions).toEqual([]);
  });

  it("refuses with exit 1 to start a stopped app scaled to no instance", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", instances: 0, running: 0, ready: 0 });
    const t = await target();
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
    const error = await failure(t.start());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(`cf scale ${API.name} -i 1`);
    expect(cf.actions).toEqual([]);
  });

  it("refuses with exit 1 while a rolling deployment of the app is active", async () => {
    cf.activeDeployments.add(API.guid);
    const t = await target();
    const error = await failure(t.status());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("deployment");
    await failure(t.start());
    expect(cf.actions).toEqual([]);
  });

  it("stops and starts the app by its guid, waits until an instance runs, and never names another app", async () => {
    const t = await target();
    const stopped = await t.stop();
    expect(stopped.stoppedAt).toBeGreaterThan(0);
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
    await t.start();
    expect(await t.waitReady(5000)).toBe(true);
    expect(cf.actions).toEqual([{ app: API.name, space: "dev", action: "stop" }, { app: API.name, space: "dev", action: "start" }]);
    expect(cf.calls).toContainEqual(["curl", `/v3/apps/${API.guid}/actions/stop`, "-X", "POST"]);
    expect(cf.calls).toContainEqual(["curl", `/v3/apps/${API.guid}/actions/start`, "-X", "POST"]);
    expect(cf.calls.some((argv) => argv[0] === "stop" || argv[0] === "start")).toBe(false);
    expect(namesOtherApp()).toEqual([]);
    expect(cf.colors.every((color) => color === "false")).toBe(true);
  });

  it("waits while the stopped app's instance reports STOPPING until its shutdown ended, without the stop grace", async () => {
    let shutDown = false;
    cf.stopLag = 0;
    cf.hooks.stop = async () => {
      await new Promise((done) => setTimeout(done, 400));
      shutDown = true;
    };
    const t = await target({ stopGraceSeconds: 60 });
    const began = Date.now();
    await t.stop();
    expect(shutDown).toBe(true);
    expect(Date.now() - began).toBeLessThan(30_000);
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
  });

  it("waits the stop grace after the stop request when the platform lists the shutting-down instance as DOWN", async () => {
    let shutDown = false;
    cf.stopLag = 0;
    cf.stoppingState = "DOWN";
    cf.hooks.stop = async () => {
      await new Promise((done) => setTimeout(done, 2500));
      shutDown = true;
    };
    const t = await target({ stopGraceSeconds: 4 });
    const began = Date.now();
    await t.stop();
    expect(shutDown).toBe(true);
    expect(Date.now() - began).toBeGreaterThanOrEqual(4000);
  });

  it("waits no stop grace for an app that had no running instance before the stop", async () => {
    Object.assign(cf.app(API.name), { running: 0, ready: 0 });
    cf.stoppingState = "DOWN";
    const t = await target({ stopGraceSeconds: 60 });
    const began = Date.now();
    await t.stop();
    expect(Date.now() - began).toBeLessThan(30_000);
  });

  it("rejects a stop grace below 0 or above 600 seconds with exit 2", async () => {
    for (const stopGraceSeconds of [-1, 601, "15"]) expect((await failure(target({ stopGraceSeconds }))).exitCode).toBe(2);
  });

  it("keeps waiting through failed status reads after the stop until the app reads stopped", async () => {
    cf.stopLag = 3;
    cf.hooks.stop = async () => {
      cf.failNext.set("curl", 2);
    };
    const t = await target();
    await t.stop();
    expect(await t.status()).toEqual({ state: "stopped", instances: 0 });
    expect(cf.actions.map((action) => action.action)).toEqual(["stop"]);
  });

  it("ends with exit 1 naming the stopped app and how to start it when it does not read stopped in time", async () => {
    cf.stopLag = 1_000_000;
    const t = await target({}, {}, { stopTimeoutMs: 50 });
    const lagging = await failure(t.stop());
    expect(lagging.exitCode).toBe(1);
    expect(lagging.message).toContain("1 instance");
    expect(lagging.message).toContain(`cf start ${API.name}`);
    cf.rejectedActions.add("stop");
    const refused = await failure(t.stop());
    expect(refused.exitCode).toBe(1);
    expect(refused.message).toContain(`stopping ${API.name} failed`);
    expect(refused.message).toContain(`cf start ${API.name}`);
    cf.rejectedActions.clear();
    cf.hooks.stop = async () => {
      cf.failures.set("curl", 1);
    };
    Object.assign(cf.app(API.name), { state: "STARTED", running: 1, ready: 1, downAfter: 0 });
    const unreadable = await failure(t.stop());
    expect(unreadable.exitCode).toBe(1);
    expect(unreadable.message).toContain("could not be read");
    expect(unreadable.message).toContain(`cf start ${API.name}`);
  });

  it("reads an app that reports STOPPED with an instance not yet DOWN as stopped with that instance, and refuses to change it", async () => {
    writeFileSync(join(root, "manifest.yml"), MANIFEST);
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 1, ready: 1 });
    const t = await target({ manifest: "manifest.yml", vars: { storage_secret: { env: "APP_STORAGE_SECRET" }, session_secret: { env: "APP_SESSION_SECRET" } } }, { APP_STORAGE_SECRET: SECRET, APP_SESSION_SECRET: OTHER_SECRET });
    expect(await t.status()).toEqual({ state: "stopped", instances: 1 });
    expect((await failure(t.setDroplet("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f"))).exitCode).toBe(1);
    expect((await failure(t.applyManifest())).exitCode).toBe(1);
    expect(cf.applied).toEqual([]);
    expect(cf.actions).toEqual([]);
  });

  it("keeps reading through a failed status read before the start and starts the app", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
    const t = await target();
    cf.failNext.set("curl", 2);
    await t.start();
    expect(cf.actions.map((action) => action.action)).toEqual(["start"]);
    expect(await t.waitReady(5000)).toBe(true);
  });

  it("ends with exit 1 without a start, naming the stopped app, when its state cannot be read in time", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
    const t = await target({}, {}, { readTimeoutMs: 50 });
    await t.status();
    cf.failures.set("curl", 1);
    const error = await failure(t.start());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("could not be read");
    expect(error.message).toContain(`cf start ${API.name}`);
    expect(cf.actions).toEqual([]);
  });

  it("counts the start as done when the start request fails but the app reads started afterwards", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
    cf.lostAnswers.add("start");
    const t = await target();
    await t.start();
    expect(cf.actions.map((action) => action.action)).toEqual(["start"]);
    expect(await t.waitReady(5000)).toBe(true);
  });

  it("waits through a failed read of the instances after the start until an instance runs", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
    cf.hooks.start = async () => {
      cf.failNext.set("curl", 1);
    };
    const t = await target();
    await t.start();
    expect(await t.waitReady(30_000)).toBe(true);
  });

  it("answers false when the instances cannot be read before the timeout", async () => {
    const t = await target();
    await t.status();
    cf.failures.set("curl", 1);
    expect(await t.waitReady(50)).toBe(false);
  });

  it("answers false when no instance runs before the timeout", async () => {
    const t = await target();
    const app = cf.app(API.name);
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

  it("ends with exit 1 naming the app when the platform refuses the start", async () => {
    cf.rejectedActions.add("start");
    const t = await target();
    const app = cf.app(API.name);
    Object.assign(app, { state: "STOPPED", running: 0, ready: 0 });
    const error = await failure(t.start());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain(`starting ${API.name} failed`);
    expect(error.message).toContain(`cf logs ${API.name} --recent`);
  });

  it("acts only on the app of the configured space after cf was switched to another space with an app of the same name", async () => {
    const twin = cf.addApp({ name: API.name, guid: "0d4b8f2a-6c1e-4a7d-b3f5-9e2c7a1d0b48", space: "staging" });
    writeFileSync(join(root, "manifest.yml"), MANIFEST);
    const t = await target({ manifest: "manifest.yml", vars: { storage_secret: { env: "APP_STORAGE_SECRET" }, session_secret: { env: "APP_SESSION_SECRET" } } }, { APP_STORAGE_SECRET: SECRET, APP_SESSION_SECRET: OTHER_SECRET });
    expect(await t.status()).toEqual({ state: "started", instances: 1 });
    cf.space = "staging";
    await t.stop();
    const switched = await failure(t.applyManifest());
    expect(switched.exitCode).toBe(2);
    expect(switched.message).toContain("cf target -o example-org -s dev");
    expect(cf.applied).toEqual([]);
    await t.setDroplet("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f");
    const evidence = (await t.stopEvidence?.()) ?? [];
    expect(evidence.some((line) => line.includes("logs") && line.includes("cf target -o example-org -s dev"))).toBe(true);
    await t.start();
    expect(cf.actions.map((action) => `${action.space} ${action.action}`)).toEqual(["dev stop", "dev set-droplet", "dev start"]);
    expect(twin).toMatchObject({ state: "STARTED", running: 1, droplet: "d7c1a3e0-0000-4000-8000-000000000001" });
    expect(cf.calls.some((argv) => argv[0] === "logs" || argv[0] === "apply-manifest")).toBe(false);
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
    expect(cf.actions).toEqual([]);
  });

  it("runs cf without trace output, which would come before the answer on standard output", async () => {
    const t = await target({}, { CF_TRACE: "true" });
    expect(await t.status()).toEqual({ state: "started", instances: 1 });
    expect(cf.traces.every((trace) => trace === "false")).toBe(true);
  });

  it("names an expired cf session next to a missing app when cf target answers but cf app --guid fails", async () => {
    cf.sessionExpired = true;
    const error = await failure((await target()).status());
    expect(error.exitCode).toBe(2);
    expect(error.message).toContain(`cf app ${API.name} --guid exited with 1`);
    expect(error.message).toContain("cf login");
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
    expect(facts).toMatchObject({ kind: "cloudfoundry", app: API.name, appGuid: API.guid, org: "example-org", space: "dev", droplet: "d7c1a3e0-0000-4000-8000-000000000001", revision: { guid: "e2a4c6f8-0000-4000-8000-000000000003", version: 3 }, envNames: ["NODE_ENV", "STORAGE_SECRET"], packages: { "@michaelthielemann/kestrel-replication-sqlite": "6.0.0" } });
    expect(JSON.stringify(facts)).not.toContain(SECRET);
    expect(namesOtherApp()).toEqual([]);
    cf.app(API.name).revision = null;
    expect((await (await target()).describe()).revision).toBeNull();
  });

  it("records no droplet for an app without a current droplet, and fails the description when the droplet cannot be read", async () => {
    const t = await target();
    cf.app(API.name).droplet = null;
    expect((await t.describe()).droplet).toBeNull();
    cf.app(API.name).droplet = "d7c1a3e0-0000-4000-8000-000000000001";
    cf.failingPaths.add(`/v3/apps/${API.guid}/droplets/current`);
    const error = await failure(t.describe());
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("droplets/current");
  });

  it("refuses with exit 1 to describe an app scaled to more than one instance or with an active deployment", async () => {
    const app = cf.app(API.name);
    app.instances = 2;
    const scaled = await failure((await target()).describe());
    expect(scaled.exitCode).toBe(1);
    expect(scaled.message).toContain("2 instances");
    app.instances = 1;
    cf.activeDeployments.add(API.guid);
    const deploying = await failure((await target()).describe());
    expect(deploying.exitCode).toBe(1);
    expect(deploying.message).toContain("deployment");
  });

  it("shows stop and crash events and teardown error lines as evidence for a stop without a seal", async () => {
    const app = cf.app(API.name);
    app.events = [{ type: "audit.app.stop", created_at: "2026-11-14T10:00:00Z" }, { type: "audit.app.update", created_at: "2026-11-14T09:00:00Z" }, { type: "app.crash", created_at: "2026-11-14T08:00:00Z" }];
    app.logs = ["2026-11-14T10:00:01Z [APP/PROC/WEB/0] OUT listening", "2026-11-14T10:00:02Z [APP/PROC/WEB/0] ERR replication: teardown sync failed: timeout", "2026-11-14T10:00:03Z [CELL/0] OUT Stopping instance"];
    const evidence = await (await target()).stopEvidence?.();
    expect(evidence).toEqual(["2026-11-14T10:00:00Z audit.app.stop", "2026-11-14T08:00:00Z app.crash", "2026-11-14T10:00:02Z [APP/PROC/WEB/0] ERR replication: teardown sync failed: timeout"]);
  });

  describe("manifest", () => {
    beforeEach(() => {
      writeFileSync(join(root, "manifest.yml"), MANIFEST);
      const app = cf.app(API.name);
      Object.assign(app, { state: "STOPPED", running: 0, ready: 0 });
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
      expect(cf.app(API.name).env).toEqual({ NODE_ENV: "production", STORAGE_SECRET: SECRET, SESSION_SECRET: OTHER_SECRET });
      expect(cf.app(WEB.name).env).toEqual({});
    });

    for (const scale of ["instances: 2", "instances: 0", "processes:\n  - type: web\n    instances: 3"]) {
      it(`refuses with exit 2 before cf runs an entry that scales the app with ${scale.replaceAll("\n", " ").replaceAll(/ +/g, " ")}`, async () => {
        writeFileSync(join(root, "scaled.yml"), `applications:\n- name: site-api\n  ${scale}\n`);
        const error = await failure((await target({ manifest: "scaled.yml" })).applyManifest());
        expect(error.exitCode).toBe(2);
        expect(error.message).toContain("exactly one");
        expect(cf.calls.some((argv) => argv[0] === "apply-manifest")).toBe(false);
        expect(cf.app(API.name).instances).toBe(1);
      });
    }

    it("applies an entry that keeps one web instance and scales another process type", async () => {
      writeFileSync(join(root, "worker.yml"), "applications:\n- name: site-api\n  instances: 1\n  processes:\n  - type: web\n    instances: 1\n  - type: worker\n    instances: 2\n");
      await (await target({ manifest: "worker.yml" })).applyManifest();
      expect(cf.applied).toHaveLength(1);
      expect(cf.app(API.name).instances).toBe(1);
    });

    it("resolves merge keys and YAML 1.1 booleans the way cf reads them, and keeps only the version and the app's resolved entry", async () => {
      writeFileSync(join(root, "shared.yml"), `version: 1
defaults: &defaults
  memory: 1024M
  buildpacks: [nodejs_buildpack]
  env:
    STORAGE_SECRET: ((storage_secret))
web-defaults: &web
  env:
    UPSTREAM: ((upstream_host))
applications:
- name: site-web
  <<: *web
  memory: 64M
- name: site-api
  <<: *defaults
  no-route: yes
  random-route: no
`);
      const t = await target({ manifest: "shared.yml", vars: { storage_secret: { env: "APP_STORAGE_SECRET" } } }, { APP_STORAGE_SECRET: SECRET });
      await t.applyManifest();
      const [applied] = cf.applied;
      if (applied === undefined) throw new Error("nothing applied");
      expect(JSON.parse(applied.manifest)).toEqual({ version: 1, applications: [{ name: API.name, memory: "1024M", buildpacks: ["nodejs_buildpack"], env: { STORAGE_SECRET: "((storage_secret))" }, "no-route": true, "random-route": false }] });
      expect(JSON.parse(applied.vars)).toEqual({ storage_secret: SECRET });
    });

    it("keeps unquoted dates and clock times as strings and octal numbers as numbers, as cf reads them", async () => {
      writeFileSync(join(root, "dated.yml"), `applications:
- name: site-api
  env:
    RELEASE_DATE: 2026-11-14
    RELEASED_AT: 2026-11-14 10:00:00
    BACKUP_TIME: 03:00
    WINDOW: 12:30
    PRECISE: 1:30.5
    UMASK: 0755
`);
      await (await target({ manifest: "dated.yml" })).applyManifest();
      const [applied] = cf.applied;
      if (applied === undefined) throw new Error("nothing applied");
      expect(JSON.parse(applied.manifest)).toEqual({ applications: [{ name: API.name, env: { RELEASE_DATE: "2026-11-14", RELEASED_AT: "2026-11-14 10:00:00", BACKUP_TIME: "03:00", WINDOW: "12:30", PRECISE: "1:30.5", UMASK: 493 } }] });
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

    it("removes the variables file when the process exits while cf apply-manifest runs", async () => {
      const temp = join(root, "temp");
      mkdirSync(temp);
      const script = join(root, "exit-during-apply.mjs");
      writeFileSync(script, `import { withManifestFiles } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "manifest.ts")).href)};
await withManifestFiles("applications: []", { storage_secret: ${JSON.stringify(SECRET)} }, async (manifestFile) => {
  process.stdout.write(manifestFile);
  process.exit(143);
});
`);
      const outcome = await new Promise<{ code: number | null; stdout: string }>((done) => {
        execFile(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-transform-types", script], { env: { ...process.env, TMPDIR: temp } }, (error, stdout) => done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout }));
      });
      expect(outcome.code).toBe(143);
      expect(outcome.stdout.startsWith(temp)).toBe(true);
      expect(readdirSync(temp)).toEqual([]);
    });

    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
      it(`removes the variables file and ends by ${signal} when ${signal} arrives while cf apply-manifest runs`, async () => {
        const outcome = await signalDuringUse(signal, "");
        expect(outcome.signal).toBe(signal);
        expect(outcome.stdout.startsWith(outcome.temp)).toBe(true);
        expect(readdirSync(outcome.temp)).toEqual([]);
      });
    }

    it("removes the variables file on SIGTERM and leaves the ending to a SIGTERM listener of the host process", async () => {
      const outcome = await signalDuringUse("SIGTERM", `process.on("SIGTERM", () => setTimeout(() => process.exit(7), 50));\n`);
      expect(outcome.code).toBe(7);
      expect(outcome.signal).toBeNull();
      expect(readdirSync(outcome.temp)).toEqual([]);
    });

    it("refuses with exit 1 while the app runs", async () => {
      const app = cf.app(API.name);
      Object.assign(app, { state: "STARTED", running: 1, ready: 1 });
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

    it("reads a placeholder with a leading ! by its name, as cf does", async () => {
      writeFileSync(join(root, "bang.yml"), "applications:\n- name: site-api\n  env:\n    STORAGE_SECRET: ((!storage_secret))\n");
      const missing = await failure((await target({ manifest: "bang.yml" })).applyManifest());
      expect(missing.exitCode).toBe(2);
      expect(missing.message).toContain("((storage_secret))");
      expect(cf.calls.some((argv) => argv[0] === "apply-manifest")).toBe(false);
      await (await target({ manifest: "bang.yml", vars: { storage_secret: { env: "APP_STORAGE_SECRET" } } }, { APP_STORAGE_SECRET: SECRET })).applyManifest();
      const [applied] = cf.applied;
      if (applied === undefined) throw new Error("nothing applied");
      expect(JSON.parse(applied.vars)).toEqual({ storage_secret: SECRET });
    });

    it("refuses with exit 2 before cf runs a placeholder with a dotted path, which cf reads as a field of another variable", async () => {
      writeFileSync(join(root, "dotted.yml"), "applications:\n- name: site-api\n  env:\n    DATABASE_URL: ((db.url))\n");
      const error = await failure((await target({ manifest: "dotted.yml", vars: { db: { env: "APP_STORAGE_SECRET" } } }, { APP_STORAGE_SECRET: SECRET })).applyManifest());
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain("((db.url))");
      expect(cf.calls.some((argv) => argv[0] === "apply-manifest")).toBe(false);
      const dotted = await failure(target({ manifest: "dotted.yml", vars: { "db.url": { env: "APP_STORAGE_SECRET" } } }));
      expect(dotted.exitCode).toBe(2);
      expect(dotted.message).toContain("vars");
    });

    it("sets a droplet only while the app is stopped", async () => {
      const t = await target();
      await t.setDroplet("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f");
      expect(cf.app(API.name).droplet).toBe("0b1e9d4c-2f3a-4e5b-8c6d-7a8b9c0d1e2f");
      expect(cf.actions).toEqual([{ app: API.name, space: "dev", action: "set-droplet" }]);
      const app = cf.app(API.name);
      Object.assign(app, { state: "STARTED", running: 1, ready: 1 });
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
