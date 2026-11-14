import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isUpdateTarget } from "@michaelthielemann/kestrel-ops";
import { cfRunner, cloudFoundryTarget, type CloudFoundryTarget } from "./index.ts";
import { FakeCloudFoundry, fakeJson } from "./fakeCloudFoundry.fixture.ts";

const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };

let cf: FakeCloudFoundry;
let root: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  cf.addApp({ ...API, env: { NODE_ENV: "production" } });
  root = mkdtempSync(join(tmpdir(), "kestrel-cf-update-"));
});

afterEach(async () => {
  await cf.close();
  rmSync(root, { recursive: true, force: true });
});

function target(config: Record<string, unknown> = {}): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev", ...config }, { root, clock: Date.now }, { env: cf.env({ ...process.env }), pollMs: 5 });
}

describe("the Cloud Foundry target as an update target", () => {
  it("offers every method an update drives", async () => {
    expect(isUpdateTarget(await target())).toBe(true);
  });

  it("reads the current droplet, and null for an app without one", async () => {
    const t = await target();
    expect(await t.currentDroplet()).toBe(cf.app(API.name).droplet);
    cf.app(API.name).droplet = null;
    expect(await t.currentDroplet()).toBeNull();
  });

  it("applies the release's manifest only when the environment names one", async () => {
    cf.app(API.name).state = "STOPPED";
    cf.app(API.name).running = 0;
    await (await target()).applyReleaseConfiguration({ dir: root });
    expect(cf.applied).toHaveLength(0);
    writeFileSync(join(root, "manifest.yml"), "applications:\n- name: site-api\n  env:\n    KESTREL_MIGRATIONS: check\n");
    await (await target({ manifest: "manifest.yml" })).applyReleaseConfiguration({ dir: root });
    expect(cf.applied).toHaveLength(1);
    expect(cf.app(API.name).env.KESTREL_MIGRATIONS).toBe("check");
  });

  it("lets a test add API routes and subcommands to the fake platform, with request bodies read from a file", async () => {
    const bodies: string[] = [];
    cf.routes.push(({ method, url, data }) => {
      if (method !== "PATCH" || !url.pathname.endsWith("/environment_variables")) return undefined;
      bodies.push(data);
      return fakeJson({ var: {} });
    });
    cf.commands.set("stage-package", () => ({ code: 0, stdout: "droplet guid: 0b1c2d3e-0000-4000-8000-000000000009\n", stderr: "" }));
    const body = join(root, "body.json");
    writeFileSync(body, JSON.stringify({ var: { A: "1" } }));
    const run = cfRunner(cf.env({ ...process.env }));
    expect((await run(["curl", `/v3/apps/${API.guid}/environment_variables`, "-X", "PATCH", "-d", `@${body}`])).code).toBe(0);
    expect(bodies).toEqual([JSON.stringify({ var: { A: "1" } })]);
    expect((await run(["stage-package", API.name])).stdout).toContain("droplet guid");
  });
});
