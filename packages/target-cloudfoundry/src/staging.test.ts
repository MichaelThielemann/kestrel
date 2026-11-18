import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { OpsError } from "@michaelthielemann/kestrel-ops";
import type { CfSession } from "./session.ts";
import { cfRunner, cloudFoundryTarget, type CloudFoundryTarget } from "./index.ts";
import { FakeCloudFoundry } from "./fakeCloudFoundry.fixture.ts";
import { installStaging, type FakeStaging } from "./fakeStaging.fixture.ts";
import { parseConfig } from "./config.ts";
import { probeReady } from "./staging.ts";
import { cfTimestamp } from "./session.ts";

const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };

let cf: FakeCloudFoundry;
let staging: FakeStaging;
let root: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  cf.addApp({ ...API, env: { NODE_ENV: "production" } });
  staging = installStaging(cf);
  root = mkdtempSync(join(tmpdir(), "kestrel-cf-staging-"));
});

afterEach(async () => {
  await cf.close();
  rmSync(root, { recursive: true, force: true });
});

function target(config: Record<string, unknown> = {}): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev", ...config }, { root, clock: Date.now }, { env: cf.env({ ...process.env }), pollMs: 5 });
}

async function refusal(promise: Promise<unknown>): Promise<OpsError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  if (!(error instanceof OpsError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error;
}

describe("staging a release on Cloud Foundry", () => {
  it("uploads the release as a package and stages it while the app keeps running", async () => {
    writeFileSync(join(root, "server.mjs"), "export {};\n");
    const before = cf.app(API.name).droplet;
    const staged = await (await target()).stage({ dir: root });
    expect(staging.packages).toEqual([{ guid: staged.package, app: API.name, dir: root }]);
    expect(staging.droplets).toEqual([staged.droplet]);
    const names = cf.calls.map((argv) => argv[0]);
    expect(names.indexOf("create-package")).toBeLessThan(names.indexOf("stage-package"));
    expect(cf.calls.find((argv) => argv[0] === "stage-package")).toEqual(["stage-package", API.name, "--package-guid", staged.package]);
    expect(cf.app(API.name).state).toBe("STARTED");
    expect(cf.app(API.name).droplet).toBe(before);
    expect(cf.actions).toEqual([]);
  });

  it("fails with exit 1 and never stops or starts the app when staging fails", async () => {
    staging.failStaging = "NoAppDetectedError: no buildpack detects the release";
    const before = cf.app(API.name).droplet;
    const error = await refusal((await target()).stage({ dir: root }));
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain("staging failed");
    expect(error.message).not.toContain("NoAppDetectedError");
    expect(cf.actions.filter((a) => a.action === "stop" || a.action === "start")).toEqual([]);
    expect(cf.app(API.name).state).toBe("STARTED");
    expect(cf.app(API.name).droplet).toBe(before);
  });

  it("refuses a release directory the platform cannot upload", async () => {
    expect((await refusal((await target()).stage({ dir: join(root, "missing") }))).exitCode).toBe(1);
    expect(staging.droplets).toEqual([]);
  });
});

describe("the preflight of the Cloud Foundry target", () => {
  it("reports two instances and an active deployment without refusing", async () => {
    Object.assign(cf.app(API.name), { instances: 2, running: 2, ready: 2 });
    staging.healthChecks.set(API.name, "http");
    cf.activeDeployments.add(API.guid);
    const found = await (await target()).preflight();
    expect(found.instances).toBe(2);
    expect(found.running).toBe(2);
    expect(found.healthCheck).toBe("http");
    expect(found.activeDeployment).toContain("rolling");
  });

  it("reports one stopped instance and the platform's default health check", async () => {
    Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
    expect(await (await target({ readyUrl: "https://site.example.net/ready" })).preflight()).toEqual({ instances: 1, running: 0, activeDeployment: null, healthCheck: "port", readinessChecked: true });
  });

  it("reports that readiness is not checked without a readiness URL", async () => {
    expect((await (await target()).preflight()).readinessChecked).toBe(false);
  });
});

describe("crash events of the Cloud Foundry app", () => {
  it("lists crashes at or after the given time with their exit description", async () => {
    const since = Date.parse("2026-11-15T01:00:00Z");
    staging.crashes.push({ app: API.name, type: "audit.app.process.crash", created_at: "2026-11-15T00:59:00Z", data: { exit_description: "before" } });
    staging.crashes.push({ app: API.name, type: "audit.app.process.crash", created_at: "2026-11-15T01:02:00Z", data: { exit_description: "APP/PROC/WEB: Exited with status 1" } });
    cf.app(API.name).events.push({ type: "audit.app.start", created_at: "2026-11-15T01:01:00Z" });
    expect(await (await target()).crashEvents(since)).toEqual([{ at: Date.parse("2026-11-15T01:02:00Z"), type: "audit.app.process.crash", reason: "APP/PROC/WEB: Exited with status 1" }]);
  });

  it("asks for events from the whole second of a time with milliseconds and keeps only those at or after the exact time", async () => {
    const since = Date.parse("2026-11-15T01:00:05.770Z");
    staging.crashes.push({ app: API.name, type: "audit.app.process.crash", created_at: "2026-11-15T01:00:05.500Z", data: { exit_description: "before" } });
    staging.crashes.push({ app: API.name, type: "audit.app.process.crash", created_at: "2026-11-15T01:00:05.900Z", data: { exit_description: "APP/PROC/WEB: Exited with status 1" } });
    expect(await (await target()).crashEvents(since)).toEqual([{ at: Date.parse("2026-11-15T01:00:05.900Z"), type: "audit.app.process.crash", reason: "APP/PROC/WEB: Exited with status 1" }]);
    const query = cf.calls.find((argv) => argv[0] === "curl" && (argv[1] ?? "").startsWith("/v3/audit_events"))?.[1] ?? "";
    expect(new URL(query, "https://api.example.test").searchParams.get("created_ats[gte]")).toBe("2026-11-15T01:00:05Z");
  });
});

describe("timestamps in Cloud Foundry filters", () => {
  it("are whole seconds in UTC, rounded down", () => {
    expect(cfTimestamp(Date.parse("2026-11-15T01:00:05.999Z"))).toBe("2026-11-15T01:00:05Z");
    expect(cfTimestamp(Date.parse("2026-11-15T01:00:05Z"))).toBe("2026-11-15T01:00:05Z");
    expect(cfTimestamp(Date.parse("2026-11-15T02:00:05.001+01:00"))).toBe("2026-11-15T01:00:05Z");
  });
});

describe("timestamp filters of the fake Cloud Foundry API", () => {
  const curl = async (path: string): Promise<unknown> => JSON.parse((await cfRunner(cf.env({ ...process.env }))(["curl", path])).stdout);
  const refused = { errors: [expect.objectContaining({ code: 10005, title: "CF-BadQueryParameter" })] };

  it("refuses a created_ats or updated_ats value with milliseconds, a time zone offset or no time, as the Cloud Controller does", async () => {
    for (const value of ["2026-11-15T01:00:05.770Z", "2026-11-15T01:00:05+01:00", "2026-11-15"]) {
      expect(await curl(`/v3/audit_events?target_guids=${API.guid}&created_ats[gte]=${value}`)).toEqual(refused);
      expect(await curl(`/v3/apps/${API.guid}/droplets?updated_ats[lt]=${value}`)).toEqual(refused);
      expect(await curl(`/v3/audit_events?created_ats=2026-11-15T01:00:05Z,${value}`)).toEqual(refused);
    }
    expect(await curl(`/v3/audit_events?created_ats[after]=2026-11-15T01:00:05Z`)).toEqual(refused);
  });

  it("answers audit events within the created_ats bounds of whole seconds", async () => {
    cf.app(API.name).events.push({ type: "audit.app.start", created_at: "2026-11-15T01:00:04Z" }, { type: "audit.app.stop", created_at: "2026-11-15T01:00:05Z" });
    expect(await curl(`/v3/audit_events?target_guids=${API.guid}&created_ats[gte]=2026-11-15T01:00:05Z`)).toEqual({ resources: [{ type: "audit.app.stop", created_at: "2026-11-15T01:00:05Z", data: {} }] });
    expect(await curl(`/v3/audit_events?target_guids=${API.guid}&created_ats[lt]=2026-11-15T01:00:05Z`)).toEqual({ resources: [{ type: "audit.app.start", created_at: "2026-11-15T01:00:04Z", data: {} }] });
  });
});

describe("the readiness probe of the Cloud Foundry target", () => {
  let server: Server;
  let base: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? "/";
      if (path === "/hang") return;
      const status = Number(path.split("/")[1] ?? "200");
      response.statusCode = Number.isFinite(status) ? status : 200;
      const state = /\/(booting|failed)$/.exec(path)?.[1];
      response.end(state !== undefined ? JSON.stringify({ ready: false, state, code: state }) : path.endsWith("/not-ready") ? JSON.stringify({ ready: false }) : JSON.stringify({ ready: true }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  function session(readyUrl: string | undefined, running = true): CfSession {
    const config = parseConfig({ app: API.name, org: "example-org", space: "dev", ...(readyUrl === undefined ? {} : { readyUrl }) });
    return {
      app: API.name,
      config,
      deps: { root, clock: Date.now },
      env: {},
      pollMs: 5,
      run: cfRunner({}),
      api: async <T>(_path: string, schema: z.ZodType<T>) => schema.parse({ resources: [{ state: running ? "RUNNING" : "CRASHED" }] }),
      appGuid: async () => API.guid,
      confirmTarget: async () => undefined,
      requireStopped: async () => undefined,
      status: async () => ({ state: "started", instances: 1 }),
    };
  }

  it.each([
    ["/200", { outcome: "ready", status: 200 }],
    ["/200/not-ready", { outcome: "not-ready", status: 200 }],
    ["/503", { outcome: "not-ready", status: 503 }],
    ["/503/booting", { outcome: "starting", status: 503 }],
    ["/503/failed", { outcome: "not-ready", status: 503 }],
    ["/500/booting", { outcome: "not-ready", status: 500 }],
    ["/500", { outcome: "not-ready", status: 500 }],
    ["/403", { outcome: "unverifiable", status: 403 }],
    ["/401", { outcome: "unverifiable", status: 401 }],
    ["/404", { outcome: "unverifiable", status: 404 }],
  ] as const)("maps %s", async (path, expected) => {
    expect(await probeReady(session(base + path))).toMatchObject(expected);
  });

  it("is unverifiable after a timeout, without a connection and without a running instance", async () => {
    expect(await probeReady(session(`${base}/hang`), { timeoutMs: 100 })).toMatchObject({ outcome: "unverifiable", status: null, reason: "no answer within 100 ms" });
    expect(await probeReady(session("http://127.0.0.1:1/ready"))).toMatchObject({ outcome: "unverifiable", status: null, reason: "no connection" });
    expect(await probeReady(session(`${base}/200`, false))).toMatchObject({ outcome: "unverifiable", reason: "no instance runs" });
  });

  it("counts a running instance as ready without a readiness URL", async () => {
    expect(await probeReady(session(undefined))).toEqual({ outcome: "ready", status: 200 });
    expect(await (await target()).probeReady()).toEqual({ outcome: "ready", status: 200 });
  });
});
