import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { keys } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const md5 = (data: Uint8Array): string => createHash("md5").update(data).digest("hex");
const text = (data: Uint8Array | undefined): string => new TextDecoder().decode(data ?? new Uint8Array());

function separateBackupBucket(appBucket: MemoryBucket) {
  const backupBucket = new MemoryBucket("backup-bucket");
  const app = memoryStore(appBucket);
  const backups = memoryStore(backupBucket);
  const h = createHarness({ store: app });
  h.editEnvironments((file) => {
    const prod = file.environments.prod ?? {};
    prod.backups = { prefix: LOCATION, storage: { bucket: "backup-bucket" } };
  });
  const stores = { stores: (config: { bucket: string }) => (config.bucket === "backup-bucket" ? backups : app) };
  return { h, backupBucket, stores };
}

describe("copies between two stores", () => {
  it("keep the Content-Type of delivery keys through backup and restore", async () => {
    const appBucket = new MemoryBucket("app-bucket");
    const { h, backupBucket, stores } = separateBackupBucket(appBucket);
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"], stores);
      expect(backup.stderr).toBe("");
      expect(backup.code).toBe(0);
      const home = `${PREFIXES.delivery}home/index.html`;
      const etag = appBucket.objects.get(home)?.etag ?? "";
      expect(backupBucket.objects.get(LOCATION + keys.object(home, etag))?.contentType).toBe("text/html; charset=utf-8");
      h.app.run(`UPDATE pages SET "title" = 'Changed' WHERE "id" = 'home'`);
      await h.app.export();
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"], stores);
      expect(restored.code).toBe(0);
      expect(text(appBucket.objects.get(home)?.data)).toContain("<h1>Home</h1>");
      expect(appBucket.objects.get(home)?.contentType).toBe("text/html; charset=utf-8");
      expect(appBucket.objects.get(`${PREFIXES.delivery}sitemap.xml`)?.contentType).toBe("application/xml");
    } finally {
      await h.dispose();
    }
  });

  it("refuse an original whose bytes do not hash to the checksum of its media row", async () => {
    const appBucket = new MemoryBucket("app-bucket-sum");
    const { h, stores } = separateBackupBucket(appBucket);
    try {
      await h.app.start();
      await h.app.seed();
      appBucket.tamper(`${PREFIXES.media}m2/plan.pdf`, new TextEncoder().encode("other bytes"));
      const backup = await h.run(["backup", "create"], stores);
      expect(backup.code).toBe(1);
      expect(backup.stderr).toContain(`the copy of ${PREFIXES.media}m2/plan.pdf does not hash to the checksum of its media row`);
    } finally {
      await h.dispose();
    }
  });
});

describe("copies into objects/", () => {
  it("accept a copy whose ETag differs from a multipart source's, record it, and restore to a no-op", async () => {
    const bucket = new MemoryBucket("multipart", { etag: (data, key, op) => (op === "put" && key.startsWith(PREFIXES.media) ? `${md5(data).slice(0, 30)}-2` : md5(data)) });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.stderr).toBe("");
      expect(backup.code).toBe(0);
      const blobs = text(bucket.objects.get(LOCATION + keys.blobs(String(backup.json.id)))?.data);
      const original = bucket.objects.get(`${PREFIXES.media}m1/harbour.jpg`);
      expect(blobs).toContain(`"etag":"${original?.etag ?? ""}"`);
      expect(blobs).toContain(`"objectEtag":"${md5(original?.data ?? new Uint8Array())}"`);
      expect((await h.run(["backup", "create", "--json"])).code).toBe(0);
      await h.app.deleteMedia("m1");
      await h.app.sync();
      const answers = h.answers({ "access-changes": "accept" });
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", answers, "--json"]);
      expect(restored.code).toBe(0);
      expect(restored.json).toMatchObject({ originalsRestored: [`${PREFIXES.media}m1/harbour.jpg`] });
      const again = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", answers, "--json"]);
      expect(again.json).toMatchObject({ noop: true, originalsRestored: [] });
    } finally {
      await h.dispose();
    }
  });

  it("remove a copy that a store ignoring copy-source-if-match wrote with the bytes of a newer version, so no later backup reuses it", async () => {
    const bucket = new MemoryBucket("mislabel", { ignoreCopyIfMatch: true });
    const sitemap = `${PREFIXES.delivery}sitemap.xml`;
    let original: Uint8Array = new Uint8Array();
    let before = "";
    bucket.options.beforeCopy = (key) => {
      if (before !== "" || key !== sitemap) return;
      original = bucket.objects.get(key)?.data ?? new Uint8Array();
      before = bucket.objects.get(key)?.etag ?? "";
      bucket.tamper(key, new TextEncoder().encode(text(original).replace("/contact/", "/xxxxxxx/")));
    };
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      expect((await h.run(["backup", "create", "--json"])).code).toBe(0);
      expect(bucket.objects.has(LOCATION + keys.object(sitemap, before))).toBe(false);
      bucket.tamper(sitemap, original);
      const second = await h.run(["backup", "create", "--json"]);
      expect(second.code).toBe(0);
      expect(text(bucket.objects.get(LOCATION + keys.object(sitemap, before))?.data)).toContain("/contact/");
      bucket.tamper(sitemap, new TextEncoder().encode("changed"));
      expect((await h.run(["restore", "--backup", String(second.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" })])).code).toBe(0);
      expect(text(bucket.objects.get(sitemap)?.data)).toContain("/contact/");
    } finally {
      await h.dispose();
    }
  });
});
