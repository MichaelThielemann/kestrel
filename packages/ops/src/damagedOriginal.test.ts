import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, LOCATION, PREFIXES, type Harness } from "./harness.fixture.ts";
import { keys, parseJson, type Manifest } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import type { RunOptions } from "./run.ts";

const harbour = `${PREFIXES.media}m1/harbour.jpg`;
const text = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

async function restoreOverDamage(h: Harness, appBucket: MemoryBucket, backupBucket: MemoryBucket, extra: Partial<RunOptions> = {}): Promise<void> {
  await h.app.start();
  await h.app.seed();
  const backup = await h.run(["backup", "create", "--freeze", "--json"], extra);
  expect(backup.code).toBe(0);
  appBucket.tamper(harbour, new TextEncoder().encode("encrypted by someone else"));

  const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], extra);
  expect(restored.stderr).toContain(`${harbour} does not hash to the checksum of its media row`);
  expect(restored.code).toBe(0);
  expect(text(appBucket.objects.get(harbour)?.data)).toBe("harbour image bytes");
  const safety = String(restored.json.safetyBackup);
  expect(safety).toMatch(/-pre-restore-/);
  const manifestData = backupBucket.objects.get(LOCATION + keys.manifest(safety))?.data;
  const manifest = boundaryCast<Manifest>(parseJson(manifestData ?? new Uint8Array()), "json");
  expect(manifest.blobs.mismatchAtBackup).toEqual([{ key: harbour, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  const verified = await h.run(["backup", "verify", safety, "--json"], extra);
  expect(verified.code).toBe(0);
}

describe("a restore over an original that was overwritten outside the tool", () => {
  it("writes the pre-restore backup with the damaged original recorded and copies the backup's original back", async () => {
    const bucket = new MemoryBucket("damaged-original");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await restoreOverDamage(h, bucket, bucket);
    } finally {
      await h.dispose();
    }
  });

  it("does the same with the backup location in another bucket", async () => {
    const appBucket = new MemoryBucket("damaged-original-app");
    const backupBucket = new MemoryBucket("damaged-original-backups");
    const app = memoryStore(appBucket);
    const backups = memoryStore(backupBucket);
    const h = createHarness({ store: app });
    h.editEnvironments((file) => {
      const prod = file.environments.prod ?? {};
      prod.backups = { prefix: LOCATION, storage: { bucket: "damaged-original-backups" } };
    });
    try {
      await restoreOverDamage(h, appBucket, backupBucket, { stores: (config: { bucket: string }) => (config.bucket === "damaged-original-backups" ? backups : app) });
    } finally {
      await h.dispose();
    }
  });

  it("still refuses a manual backup of the damaged original", async () => {
    const bucket = new MemoryBucket("damaged-original-manual");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      bucket.tamper(harbour, new TextEncoder().encode("encrypted by someone else"));
      const backup = await h.run(["backup", "create", "--freeze"]);
      expect(backup.code).toBe(1);
      expect(backup.stderr).toContain(`${harbour}`);
      expect(backup.stderr).toContain("does not hash to the checksum of its media row");
    } finally {
      await h.dispose();
    }
  });
});

describe("a restore whose pre-restore backup fails", () => {
  it("names --no-safety-backup in its error", async () => {
    const bucket = new MemoryBucket("safety-fails");
    const inner = memoryStore(bucket);
    let failManifest = false;
    const store = {
      ...inner,
      put: async (key: string, data: Uint8Array, options?: { contentType?: string }) => {
        if (failManifest && key.includes("-pre-restore-") && key.endsWith("/manifest.json")) throw new Error(`connection reset writing ${key}`);
        return inner.put(key, data, options);
      },
    };
    const h = createHarness({ store });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
      await h.app.sync();
      failManifest = true;
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(restored.code).toBe(1);
      expect(restored.stderr).toContain("--no-safety-backup");
      expect((await h.app.status()).state).toBe("started");
    } finally {
      await h.dispose();
    }
  });
});
