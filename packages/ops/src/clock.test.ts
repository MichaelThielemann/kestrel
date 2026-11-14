import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const text = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

describe("restore and the store's clock", () => {
  it("refuses a clock more than 30 s off before it changes anything, and starts the app again", async () => {
    const bucket = new MemoryBucket("skew", { clock: () => Date.now() - 60_000 });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
      await h.app.export();
      await h.app.sync();
      const refused = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })]);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("refusing to promote: this machine's clock is 60 s off the store's (limit 30 s)");
      expect(refused.stderr).not.toContain("the app stays stopped");
      expect(text(bucket.objects.get(`${PREFIXES.delivery}home/index.html`)?.data)).toContain("<h1>Changed</h1>");
      expect([...bucket.objects.keys()].filter((k) => k.includes("-pre-restore-"))).toEqual([]);
      expect((await h.app.status()).state).toBe("started");
      expect(h.app.rows("pages")).toContainEqual({ id: "home", title: "Changed", body: "Welcome" });
    } finally {
      await h.dispose();
    }
  });

  it("measures the clock at the app's store, not at a separate backup store", async () => {
    const appBucket = new MemoryBucket("app-clock");
    const backupBucket = new MemoryBucket("backup-clock", { clock: () => Date.now() - 45_000 });
    const app = memoryStore(appBucket);
    const backups = memoryStore(backupBucket);
    const h = createHarness({ store: app });
    h.editEnvironments((file) => {
      const prod = file.environments.prod ?? {};
      prod.backups = { prefix: LOCATION, storage: { bucket: "backup-clock" } };
    });
    const stores = { stores: (config: { bucket: string }) => (config.bucket === "backup-clock" ? backups : app) };
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"], stores);
      expect(backup.code).toBe(0);
      const status = await h.run(["status", "--json"], stores);
      expect(Math.abs(Number(status.json.clockSkewMs))).toBeLessThan(5_000);
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], stores);
      expect(restored.stderr).toBe("");
      expect(restored.code).toBe(0);
      expect([...appBucket.objects.keys()].filter((k) => k.includes("/probes/") || k.startsWith("probes/"))).toEqual([]);
    } finally {
      await h.dispose();
    }
  });
});
