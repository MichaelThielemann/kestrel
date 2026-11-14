import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, LOCATION } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import type { ObjectStore } from "./store.ts";
import { localTarget, type Target } from "./target.ts";

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function waitFor(file: string): Promise<void> {
  for (let i = 0; i < 250 && !existsSync(file); i++) await pause(20);
  if (!existsSync(file)) throw new Error(`${file} did not appear`);
}

const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

describe("local target behind a wrapper that ends at once on SIGTERM", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kestrel-ops-group-"));
    mkdirSync(join(root, "app"));
    writeFileSync(join(root, "app", "child.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync('child.pid', String(process.pid));\nprocess.on('SIGTERM', () => setTimeout(() => { writeFileSync('sealed', 'yes'); process.exit(0); }, 1500));\nsetInterval(() => {}, 1000);\n");
  });
  afterEach(() => {
    const childPid = join(root, "app", "child.pid");
    if (existsSync(childPid) && !isGone(Number(readFileSync(childPid, "utf8")))) process.kill(Number(readFileSync(childPid, "utf8")), "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  });

  const wrapped = () => localTarget({ dir: "app", database: "kestrel.db", command: ["/bin/sh", "-c", `"${process.execPath}" child.mjs; echo exited`], disk: "persistent" }, { root, clock: Date.now });

  it("resolves the stop only once the app ended its teardown", async () => {
    const target = await wrapped();
    await target.start();
    await waitFor(join(root, "app", "child.pid"));
    const child = Number(readFileSync(join(root, "app", "child.pid"), "utf8"));
    await target.stop();
    expect(existsSync(join(root, "app", "sealed"))).toBe(true);
    expect(isGone(child)).toBe(true);
    expect(await target.status()).toEqual({ state: "stopped", instances: 0 });
  });

  it("reports the app started while a process of its group runs after the wrapper is gone, and stops it", async () => {
    const target = await wrapped();
    await target.start();
    await waitFor(join(root, "app", "child.pid"));
    const child = Number(readFileSync(join(root, "app", "child.pid"), "utf8"));
    const leader = boundaryCast<{ pid: number }>(JSON.parse(readFileSync(join(root, "app", ".kestrel-ops.pid"), "utf8")), "json").pid;
    process.kill(leader, "SIGKILL");
    for (let i = 0; i < 100 && !isGone(leader); i++) await pause(20);
    expect(isGone(leader)).toBe(true);
    expect(await target.status()).toEqual({ state: "started", instances: 1 });
    await expect(target.start()).rejects.toThrow(/already running/);
    await target.stop();
    expect(existsSync(join(root, "app", "sealed"))).toBe(true);
    expect(isGone(child)).toBe(true);
  });
});

function slow(inner: ObjectStore, ms: number): ObjectStore {
  const later = async <T>(run: () => Promise<T>): Promise<T> => {
    await pause(ms);
    return run();
  };
  return {
    ...inner,
    list: (prefix) => later(() => inner.list(prefix)),
    head: (key) => later(() => inner.head(key)),
    get: (key) => later(() => inner.get(key)),
    read: (key, options) => later(() => inner.read(key, options)),
    put: (key, data, options) => later(() => inner.put(key, data, options)),
    copy: (source, key, options) => later(() => inner.copy(source, key, options)),
    delete: (key) => later(() => inner.delete(key)),
  };
}

describe("local target whose command does not exist", () => {
  it("ends a frozen backup with one error document, a released lock and a failed run instead of crashing", async () => {
    const bucket = new MemoryBucket("missing-command");
    const h = createHarness({ store: slow(memoryStore(bucket), 2) });
    try {
      await h.app.start();
      await h.app.seed();
      const broken = await localTarget({ dir: "app", database: "kestrel.db", command: [join(h.root, "no-such-app")], disk: "persistent" }, { root: h.root, clock: Date.now });
      const app = h.app;
      const target: Target = {
        transport: "promote",
        describe: () => app.describe(),
        status: () => app.status(),
        stop: () => app.stop(),
        start: () => broken.start(),
        waitReady: (ms) => broken.waitReady(ms),
        stopEvidence: () => app.stopEvidence(),
      };
      const frozen = await h.run(["backup", "create", "--freeze", "--json"], { targets: { fake: () => target } });
      expect(frozen.code).toBe(1);
      expect(frozen.stdout.match(/"schema"/g)).toHaveLength(1);
      expect(frozen.json).toMatchObject({ ok: false });
      expect(String(frozen.json.message)).toContain("no-such-app");
      const keys = [...bucket.objects.keys()];
      expect(keys.some((key) => key.startsWith(`${LOCATION}locks/`) && key.includes("-released-"))).toBe(true);
      expect(keys.some((key) => key.startsWith(`${LOCATION}runs/`) && key.endsWith("-run-failed-failed.json"))).toBe(true);
      await pause(50);
    } finally {
      await h.dispose();
    }
  });
});
