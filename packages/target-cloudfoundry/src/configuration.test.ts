import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudFoundryTarget, type CloudFoundryTarget } from "./index.ts";
import { FakeCloudFoundry } from "./fakeCloudFoundry.fixture.ts";
import { FakeDroplets } from "./fakeDroplets.fixture.ts";

const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };

const SECRET = "first-token-value-7a1c";
const DEVICE = "device-key-value-2b9e";
const ROTATED = "rotated-token-value-5d3f";

let cf: FakeCloudFoundry;
let fake: FakeDroplets;
let root: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  fake = new FakeDroplets(cf);
  const app = cf.addApp({ ...API, env: { NODE_ENV: "production", KESTREL_MIGRATIONS: "apply", API_TOKEN: SECRET, DEVICE_KEY: DEVICE } });
  fake.addDroplet(app, { current: true });
  Object.assign(fake.process(app), { command: "node .output/server/index.mjs", memoryMb: 1024, diskMb: 2048, healthCheck: { type: "http", endpoint: "/api/ready", timeout: 180, invocationTimeout: 5 } });
  root = mkdtempSync(join(tmpdir(), "kestrel-cf-configuration-"));
  writeFileSync(join(root, "manifest.yml"), "applications:\n- name: site-api\n  env:\n    KESTREL_MIGRATIONS: check\n    DEVICE_KEY: ((device-key))\n");
});

afterEach(async () => {
  await cf.close();
  rmSync(root, { recursive: true, force: true });
});

function target(): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev", manifest: "manifest.yml", vars: { "device-key": { env: "DEVICE_KEY_SOURCE" } } }, { root, clock: Date.now }, { env: cf.env({ ...process.env, DEVICE_KEY_SOURCE: DEVICE }), pollMs: 5 });
}

const stop = (): void => {
  Object.assign(cf.app(API.name), { state: "STOPPED", running: 0, ready: 0 });
};

const argvText = (): string => cf.calls.map((call) => call.join(" ")).join("\n");

describe("the configuration of a Cloud Foundry app", { timeout: 60_000 }, () => {
  it("records plain variables verbatim and the host's secret names and the manifest's variables only as salted fingerprints", async () => {
    const recorded = await (await target()).readConfiguration(new Set(["API_TOKEN"]));
    expect(recorded.env.NODE_ENV).toEqual({ value: "production" });
    expect(recorded.env.KESTREL_MIGRATIONS).toEqual({ value: "apply" });
    expect(recorded.env.API_TOKEN).toEqual({ fingerprint: createHash("sha256").update(recorded.salt + SECRET).digest("hex") });
    expect(recorded.env.DEVICE_KEY).toEqual({ fingerprint: createHash("sha256").update(recorded.salt + DEVICE).digest("hex") });
    expect(recorded.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(recorded).toMatchObject({ schema: "kestrel-ops/configuration@1", droplet: cf.app(API.name).droplet, revision: { version: 1 }, healthCheck: { type: "http", endpoint: "/api/ready", timeoutSeconds: 180, invocationTimeoutSeconds: 5 }, memoryMb: 1024, diskMb: 2048, command: "node .output/server/index.mjs", instances: 1 });
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    expect(JSON.stringify(recorded)).not.toContain(DEVICE);
    expect(argvText()).not.toContain(SECRET);
  });

  it("puts a recorded configuration back verbatim while the app is stopped and reports a rotated secret as unrestorable", async () => {
    const t = await target();
    const recorded = await t.readConfiguration(new Set(["API_TOKEN"]));
    const app = cf.app(API.name);
    Object.assign(app.env, { KESTREL_MIGRATIONS: "check", ADDED_BY_RELEASE: "1", API_TOKEN: ROTATED });
    delete app.env.NODE_ENV;
    Object.assign(fake.process(app), { command: null, memoryMb: 2048, diskMb: 4096, healthCheck: { type: "process", endpoint: null, timeout: null, invocationTimeout: null } });

    await expect(t.restoreConfiguration(recorded)).rejects.toThrow("refusing to restore the configuration");
    stop();
    const restored = await t.restoreConfiguration(recorded);
    expect(restored.set.sort()).toEqual(["KESTREL_MIGRATIONS", "NODE_ENV"]);
    expect(restored.removed).toEqual(["ADDED_BY_RELEASE"]);
    expect(restored.unchanged).toEqual(["DEVICE_KEY"]);
    expect(restored.unrestorable).toEqual(["API_TOKEN"]);
    expect(app.env).toEqual({ NODE_ENV: "production", KESTREL_MIGRATIONS: "apply", API_TOKEN: ROTATED, DEVICE_KEY: DEVICE });
    expect(fake.process(app)).toMatchObject({ command: "node .output/server/index.mjs", memoryMb: 1024, diskMb: 2048, healthCheck: { type: "http", endpoint: "/api/ready", timeout: 180, invocationTimeout: 5 } });
    expect(app.state).toBe("STOPPED");

    const text = argvText();
    for (const value of ["production", "apply", SECRET, ROTATED, DEVICE, "/api/ready", "node .output/server/index.mjs"]) expect(text).not.toContain(value);
    const patched = fake.bodies.find((b) => b.method === "PATCH" && b.path.endsWith("/environment_variables"));
    expect(JSON.parse(patched?.data ?? "{}")).toEqual({ var: { NODE_ENV: "production", KESTREL_MIGRATIONS: "apply", ADDED_BY_RELEASE: null } });
    for (const call of cf.calls.filter((c) => c[0] === "curl" && c.includes("-d"))) expect(call[call.indexOf("-d") + 1]).toMatch(/^@\//);
  });

  it("restores the platform's detected start command when the recorded one is null", async () => {
    const app = cf.app(API.name);
    fake.process(app).command = null;
    const t = await target();
    const recorded = await t.readConfiguration(new Set());
    fake.process(app).command = "node other.mjs";
    stop();
    await t.restoreConfiguration(recorded);
    expect(fake.process(app).command).toBeNull();
  });
});
