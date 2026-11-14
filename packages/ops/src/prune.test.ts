import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { backupId, jsonBytes, keys, stamp, type BackupKind } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const DAY = 24 * 60 * 60 * 1000;

function writeFakeBackup(bucket: MemoryBucket, id: string, kestrel: string): void {
  const manifest = { schema: "kestrel-ops/backup@1", id, versions: { "@michaelthielemann/kestrel": kestrel } };
  bucket.write(LOCATION + keys.manifest(id), jsonBytes(manifest), "put");
  bucket.write(LOCATION + keys.blobs(id), new Uint8Array(), "put");
  bucket.write(LOCATION + keys.site(id), new Uint8Array(), "put");
}

describe("backup prune", () => {
  it("keeps the newest backups of each kind (cutover 5, scheduled 14, manual 10, pre-restore 5), pinned ones and the newest of each Kestrel major", async () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const bucket = new MemoryBucket("retention", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const ids: Record<BackupKind, string[]> = { cutover: [], scheduled: [], manual: [], "pre-restore": [] };
      const counts: Record<BackupKind, number> = { cutover: 7, scheduled: 16, manual: 12, "pre-restore": 6 };
      let at = Date.parse("2026-09-01T00:00:00Z");
      for (const kind of ["cutover", "scheduled", "manual", "pre-restore"] as const) {
        for (let i = 0; i < counts[kind]; i++) {
          at += 60_000;
          const id = backupId("prod", at, kind, (i + 16).toString(16).padStart(4, "0"));
          ids[kind].push(id);
          writeFakeBackup(bucket, id, kind === "cutover" && i === 0 ? "5.8.1" : "6.0.0");
        }
      }
      const pinned = ids.manual[0] ?? "";
      bucket.write(LOCATION + keys.pin(pinned, "run-open"), jsonBytes({}), "put");
      bucket.write(`${LOCATION}objects/${PREFIXES.media}gone@abc`, new Uint8Array([1]), "put");
      now += 3 * DAY;

      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(dry.stderr).toBe("");
      expect(dry.code).toBe(0);
      const removed = [...(ids.cutover.slice(1, 2)), ...ids.scheduled.slice(0, 2), ...ids.manual.slice(1, 2), ...ids["pre-restore"].slice(0, 1)].sort();
      expect([...boundaryCast<string[]>(dry.json.backups, "json")].sort()).toEqual(removed);
      expect(dry.json.objects).toEqual([`${LOCATION}objects/${PREFIXES.media}gone@abc`]);
      expect(bucket.objects.has(LOCATION + keys.manifest(removed[0] ?? ""))).toBe(true);

      const real = await h.run(["backup", "prune", "--yes"], { clock: () => now });
      expect(real.code).toBe(0);
      for (const id of removed) expect([...bucket.objects.keys()].some((k) => k.startsWith(LOCATION + keys.backupDir(id))), id).toBe(false);
      expect(bucket.objects.has(LOCATION + keys.manifest(pinned))).toBe(true);
      expect(bucket.objects.has(LOCATION + keys.manifest(ids.cutover[0] ?? ""))).toBe(true);
      expect(bucket.objects.has(`${LOCATION}objects/${PREFIXES.media}gone@abc`)).toBe(false);
    } finally {
      await h.dispose();
    }
  });

  it("never removes objects or incomplete backups younger than a day", async () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const bucket = new MemoryBucket("young", { clock: () => now - 60_000 });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      bucket.write(`${LOCATION}objects/${PREFIXES.media}fresh@abc`, new Uint8Array([1]), "put");
      const half = backupId("prod", now - 120_000, "manual", "00aa");
      bucket.write(LOCATION + keys.db(half), new Uint8Array([1]), "put");
      const result = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(result.json).toMatchObject({ backups: [], objects: [] });
    } finally {
      await h.dispose();
    }
  });

  it("refuses while another run is open or holds the lock", async () => {
    const bucket = new MemoryBucket("refuse");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      bucket.write(LOCATION + keys.journal("otherrun", 1, "run", "started"), jsonBytes({ data: { command: "restore" } }), "put");
      const open = await h.run(["backup", "prune", "--yes"]);
      expect(open.code).toBe(1);
      expect(open.stderr).toContain("run otherrun is still open");
      bucket.write(LOCATION + keys.journal("otherrun", 2, "run-done", "done"), jsonBytes({}), "put");
      bucket.write(LOCATION + keys.lock("lockrun", Date.now(), "start"), jsonBytes({ runId: "lockrun", command: "backup-create", host: "build-1", pid: 42 }), "put");
      const locked = await h.run(["backup", "prune", "--yes"]);
      expect(locked.code).toBe(1);
      expect(locked.stderr).toContain("another run holds the lock: lockrun (backup-create) on build-1, pid 42");
      bucket.write(LOCATION + keys.lock("lockrun", Date.now(), "released"), jsonBytes({}), "put");
      expect((await h.run(["backup", "prune", "--yes"])).code).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("refuses a second writing run while one holds the lock, until --break-lock gets an explicit answer", async () => {
    const bucket = new MemoryBucket("second");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      bucket.write(LOCATION + keys.lock("busy", Date.now(), "start"), jsonBytes({ runId: "busy", command: "restore", host: "laptop", pid: 7 }), "put");
      const result = await h.run(["backup", "create"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("another run holds the lock: busy (restore) on laptop, pid 7");
      expect((await h.run(["backup", "create", "--break-lock", "--yes"])).stderr).toContain('"break-lock" needs an answer');
      const broken = await h.run(["backup", "create", "--break-lock", "--answers", h.answers({ "break-lock": "accept" })]);
      expect(broken.code).toBe(0);
      expect([...bucket.objects.keys()].some((k) => /locks\/busy\/\d{8}T\d{6}Z-released-/.test(k))).toBe(true);
      expect(stamp(0)).toBe("19700101T000000Z");
    } finally {
      await h.dispose();
    }
  });
});

describe("copying originals into the backup", () => {
  it("lists a delivery key again when it changed between listing and copy, and records only the new version", async () => {
    const bucket = new MemoryBucket("stale-site");
    let before = "";
    bucket.options.beforeCopy = (key) => {
      if (before !== "" || key !== `${PREFIXES.delivery}sitemap.xml`) return;
      before = bucket.objects.get(key)?.etag ?? "";
      bucket.tamper(key, new TextEncoder().encode("/home/\n/about/\n/contact/\n/new/"));
    };
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const result = await h.run(["backup", "create", "--json"]);
      expect(result.code).toBe(0);
      const etag = bucket.objects.get(`${PREFIXES.delivery}sitemap.xml`)?.etag ?? "";
      expect(etag).not.toBe(before);
      expect(bucket.objects.has(LOCATION + keys.object(`${PREFIXES.delivery}sitemap.xml`, before))).toBe(false);
      expect(new TextDecoder().decode(bucket.objects.get(LOCATION + keys.site(String(result.json.id)))?.data)).toContain(`"etag":"${etag}"`);
    } finally {
      await h.dispose();
    }
  });

  it("copies an original that changed between listing and copy in its new version, which verification flags against the row checksum", async () => {
    const bucket = new MemoryBucket("stale");
    let tampered = false;
    bucket.options.beforeCopy = (key) => {
      if (tampered || key !== `${PREFIXES.media}m2/plan.pdf`) return;
      tampered = true;
      bucket.tamper(key, new TextEncoder().encode("floor plan, second version"));
    };
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const result = await h.run(["backup", "create", "--json"]);
      expect(tampered).toBe(true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${PREFIXES.media}m2/plan.pdf`);
      expect(result.stderr).toContain("does not hash to the checksum of its media row");
    } finally {
      await h.dispose();
    }
  });

  it("checks the copy with a HEAD when the store ignores copy-source-if-match and lists again on a mismatch", async () => {
    const bucket = new MemoryBucket("no-if-match", { ignoreCopyIfMatch: true });
    let tampered = false;
    bucket.options.beforeCopy = (key) => {
      if (tampered || key !== `${PREFIXES.delivery}sitemap.xml`) return;
      tampered = true;
      bucket.tamper(key, new TextEncoder().encode("/home/\n/about/\n/contact/\n/new/"));
    };
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const result = await h.run(["backup", "create", "--json"]);
      expect(result.code).toBe(0);
      const site = new TextDecoder().decode(bucket.objects.get(LOCATION + keys.site(String(result.json.id)))?.data);
      const etag = bucket.objects.get(`${PREFIXES.delivery}sitemap.xml`)?.etag ?? "";
      expect(site).toContain(`"etag":"${etag}"`);
      const stored = bucket.objects.get(LOCATION + keys.object(`${PREFIXES.delivery}sitemap.xml`, etag));
      expect(new TextDecoder().decode(stored?.data)).toContain("/new/");
    } finally {
      await h.dispose();
    }
  });
});
