import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cloudFoundryTarget, type CloudFoundryTarget } from "./index.ts";
import { FakeCloudFoundry } from "./fakeCloudFoundry.fixture.ts";
import { FakeDroplets } from "./fakeDroplets.fixture.ts";

const API = { name: "site-api", guid: "6f0c2a8e-1b7d-4c3e-9a51-0d2e8f4b7a10" };
const OTHER = { name: "site-web", guid: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d" };

let cf: FakeCloudFoundry;
let fake: FakeDroplets;
let root: string;

beforeEach(async () => {
  cf = new FakeCloudFoundry();
  await cf.listen();
  fake = new FakeDroplets(cf);
  cf.addApp({ ...API });
  cf.addApp({ ...OTHER });
  root = mkdtempSync(join(tmpdir(), "kestrel-cf-droplets-"));
});

afterEach(async () => {
  await cf.close();
  rmSync(root, { recursive: true, force: true });
});

function target(): Promise<CloudFoundryTarget> {
  return cloudFoundryTarget({ app: API.name, org: "example-org", space: "dev" }, { root, clock: Date.now }, { env: cf.env({ ...process.env }), pollMs: 5 });
}

describe("droplets and revisions of the Cloud Foundry target", { timeout: 60_000 }, () => {
  it("lists the app's droplets oldest first with the current one marked, and its revisions with the droplet each names", async () => {
    const app = cf.app(API.name);
    const first = fake.addDroplet(app, { current: true });
    const second = fake.addDroplet(app, { current: true });
    fake.addDroplet(cf.app(OTHER.name), { current: true });
    const t = await target();
    const droplets = await t.listDroplets();
    expect(droplets.map((d) => [d.guid, d.current])).toEqual([[first.guid, false], [second.guid, true]]);
    expect(droplets[0]?.createdAt).toBeLessThan(droplets[1]?.createdAt ?? 0);
    const revisions = await t.listRevisions();
    expect(revisions.map((r) => [r.version, r.droplet])).toEqual([[1, first.guid], [2, second.guid]]);
  });

  it("deletes an old droplet, and refuses the current droplet and a droplet of another app", async () => {
    const app = cf.app(API.name);
    const old = fake.addDroplet(app, { current: true });
    const current = fake.addDroplet(app, { current: true });
    const foreign = fake.addDroplet(cf.app(OTHER.name), { current: true });
    const t = await target();
    await expect(t.deleteDroplet(current.guid)).rejects.toThrow("it is the current droplet");
    await expect(t.deleteDroplet(current.guid)).rejects.toMatchObject({ exitCode: 1 });
    await expect(t.deleteDroplet(foreign.guid)).rejects.toThrow(`it is not a droplet of ${API.name}`);
    expect(cf.calls.some((call) => call.includes("DELETE"))).toBe(false);
    await t.deleteDroplet(old.guid);
    expect(fake.droplets.has(old.guid)).toBe(false);
    expect(fake.droplets.has(current.guid)).toBe(true);
    expect(fake.droplets.has(foreign.guid)).toBe(true);
    expect((await t.listRevisions()).find((r) => r.version === 1)?.droplet).toBe(old.guid);
  });

  it("saves a droplet's bits into a file only this user can read and uploads them again as a new staged droplet", async () => {
    const app = cf.app(API.name);
    const old = fake.addDroplet(app, { current: true, bits: "the old release", processTypes: { web: "node server.mjs" } });
    fake.addDroplet(app, { current: true });
    const t = await target();
    const file = join(root, "droplet.bin");
    expect(await t.saveDroplet?.(old.guid, file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(FakeDroplets.bitsOf(file)).toBe("the old release");
    await t.deleteDroplet(old.guid);

    const restored = (await t.restoreDroplet?.(file)) ?? "";
    expect(restored).not.toBe(old.guid);
    expect(fake.droplets.get(restored)).toMatchObject({ app: API.guid, state: "STAGED", bits: "the old release", processTypes: { web: "node server.mjs" } });
    expect(cf.app(API.name).droplet).not.toBe(restored);
    for (const call of cf.calls) expect(call.join(" ")).not.toContain("the old release");
  });

  it("answers false for a droplet of a container image, whose bits the platform does not hand out", async () => {
    const app = cf.app(API.name);
    const old = fake.addDroplet(app, { current: true, image: "registry.example.test/site:5" });
    fake.addDroplet(app, { current: true });
    expect(await (await target()).saveDroplet?.(old.guid, join(root, "droplet.bin"))).toBe(false);
    expect(cf.calls.some((call) => call[0] === "download-droplet")).toBe(false);
  });

  it("tries a failed download again and saves the bits once it works", async () => {
    const app = cf.app(API.name);
    const old = fake.addDroplet(app, { current: true, bits: "the old release" });
    fake.addDroplet(app, { current: true });
    fake.failDownloads = 1;
    const file = join(root, "droplet.bin");
    expect(await (await target()).saveDroplet?.(old.guid, file)).toBe(true);
    expect(FakeDroplets.bitsOf(file)).toBe("the old release");
    expect(cf.calls.filter((call) => call[0] === "download-droplet")).toHaveLength(2);
  });

  it("refuses with exit 1 when every download attempt fails, instead of answering that the platform hands out no bits", async () => {
    const app = cf.app(API.name);
    const old = fake.addDroplet(app, { current: true });
    fake.addDroplet(app, { current: true });
    fake.downloads = false;
    const t = await target();
    await expect(t.saveDroplet?.(old.guid, join(root, "droplet.bin"))).rejects.toMatchObject({ exitCode: 1 });
    await expect(t.saveDroplet?.(old.guid, join(root, "droplet.bin"))).rejects.toThrow(`downloading the bits of droplet ${old.guid}`);
  });
});
