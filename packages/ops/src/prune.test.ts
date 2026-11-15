import { describe, expect, it } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createHarness, LOCATION, PREFIXES } from "./harness.fixture.ts";
import { backupId, jsonBytes, keys, stamp, type BackupKind } from "./layout.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";

const DAY = 24 * 60 * 60 * 1000;

function writeFakeBackup(bucket: MemoryBucket, id: string, kestrel: string | { major: number }, verified: boolean | null = true): void {
  const manifest = { schema: "kestrel-ops/backup@1", id, ...(typeof kestrel === "string" ? { versions: { "@michaelthielemann/kestrel": kestrel } } : { versions: {}, major: kestrel.major }) };
  bucket.write(LOCATION + keys.manifest(id), jsonBytes(manifest), "put");
  bucket.write(LOCATION + keys.blobs(id), new Uint8Array(), "put");
  bucket.write(LOCATION + keys.site(id), new Uint8Array(), "put");
  if (verified !== null) bucket.write(LOCATION + keys.verification(id, bucket.now()), jsonBytes({ ok: verified }), "put");
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

  it("lets the pre-restore backup of a failed restore count towards the retention instead of keeping it pinned for good", async () => {
    let offset = 0;
    const clock = (): number => Date.now() + offset;
    const bucket = new MemoryBucket("failed-restore-pin", { clock });
    const h = createHarness({ store: memoryStore(bucket) });
    const waitReady = h.app.waitReady.bind(h.app);
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--freeze", "--json"]);
      expect(backup.code).toBe(0);
      h.app.run(`UPDATE pages SET "body" = 'changed after the backup' WHERE "id" = 'home'`);
      await h.app.sync();
      h.app.waitReady = async () => false;
      const failed = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      h.app.waitReady = waitReady;
      expect(failed.code).toBe(1);
      const safety = String(failed.json.backupId);
      const listed = await h.run(["backup", "list", "--json"]);
      expect(listed.json.backups).toContainEqual(expect.objectContaining({ id: safety, pinnedBy: [expect.any(String)] }));

      const newer: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = backupId("prod", clock() + (i + 1) * 60_000, "pre-restore", (i + 16).toString(16).padStart(4, "0"));
        newer.push(id);
        writeFakeBackup(bucket, id, "6.0.0");
      }
      offset = 3 * DAY;
      const status = await h.run(["status", "--json"], { clock });
      expect(status.json.openRuns).toEqual([]);
      const pruned = await h.run(["backup", "prune", "--dry-run", "--json"], { clock });
      expect(pruned.code).toBe(0);
      expect(pruned.json.backups).toContain(safety);
      for (const id of newer) expect(pruned.json.kept).toContain(id);
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

describe("backup prune at a location shared by environments", () => {
  it("keeps the objects another environment's backups refer to", async () => {
    const bucket = new MemoryBucket("shared");
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      await h.app.start();
      await h.app.seed();
      const prod = await h.run(["backup", "create", "--freeze", "--env", "prod", "--json"]);
      expect(prod.code).toBe(0);
      h.editEnvironments((file) => {
        const stage = boundaryCast<Record<string, unknown>>(JSON.parse(JSON.stringify(file.environments.prod)), "json");
        stage.production = false;
        stage.app = { replicaPrefix: "stage/database/", mediaPrefix: "stage/media/", deliveryPrefix: "stage/www/", derivedPrefixes: ["stage/media-variants/"] };
        file.environments.stage = stage;
      });
      const later = () => Date.now() + 3 * DAY;
      const pruned = await h.run(["backup", "prune", "--env", "stage", "--yes", "--json"], { clock: later });
      expect(pruned.code).toBe(0);
      expect(pruned.json.objects).toEqual([]);
      expect((await h.run(["backup", "verify", String(prod.json.id), "--env", "prod"])).code).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});

describe("backup prune and verification", () => {
  it("counts only verified backups towards the retention of their kind and keeps failed ones newer than the oldest kept verified one", async () => {
    let now = Date.parse("2026-09-01T00:00:00Z");
    const bucket = new MemoryBucket("verified-retention", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const cutover = [false, true, true, true, true, true, true, false].map((ok, i) => {
        const id = backupId("prod", now + i * 60_000, "cutover", (i + 16).toString(16).padStart(4, "0"));
        writeFakeBackup(bucket, id, "6.0.0", ok);
        return id;
      });
      for (let i = 0; i < 16; i++) writeFakeBackup(bucket, backupId("prod", now + (i + 10) * 60_000, "scheduled", (i + 16).toString(16).padStart(4, "0")), "6.0.0", i < 2);
      now += 3 * DAY;
      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(dry.code).toBe(0);
      expect(dry.json.backups).toEqual([cutover[0], cutover[1]]);
    } finally {
      await h.dispose();
    }
  });

  it("keeps the newest verified backup of each Kestrel major, not a newer failed one", async () => {
    let now = Date.parse("2026-09-01T00:00:00Z");
    const bucket = new MemoryBucket("verified-major", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      writeFakeBackup(bucket, backupId("prod", now, "manual", "0010"), "5.8.1");
      const failed = backupId("prod", now + 60_000, "manual", "0011");
      writeFakeBackup(bucket, failed, "5.8.1", false);
      for (let i = 0; i < 10; i++) writeFakeBackup(bucket, backupId("prod", now + (i + 2) * 60_000, "manual", (i + 32).toString(16).padStart(4, "0")), "6.0.0");
      now += 3 * DAY;
      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(dry.code).toBe(0);
      expect(dry.json.backups).toEqual([failed]);
    } finally {
      await h.dispose();
    }
  });
});

describe("backup prune and the major a manifest records without versions", () => {
  it("keeps the newest verified backup of a major the manifest names only by its major", async () => {
    let now = Date.parse("2026-09-01T00:00:00Z");
    const bucket = new MemoryBucket("recorded-major", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    try {
      const older = backupId("prod", now, "manual", "0010");
      writeFakeBackup(bucket, older, { major: 5 });
      const hop = backupId("prod", now + 60_000, "manual", "0011");
      writeFakeBackup(bucket, hop, { major: 5 });
      for (let i = 0; i < 10; i++) writeFakeBackup(bucket, backupId("prod", now + (i + 2) * 60_000, "manual", (i + 32).toString(16).padStart(4, "0")), "6.0.0");
      now += 3 * DAY;
      const dry = await h.run(["backup", "prune", "--dry-run", "--json"], { clock: () => now });
      expect(dry.code).toBe(0);
      expect(dry.json.backups).toEqual([older]);
    } finally {
      await h.dispose();
    }
  });
});

describe("backup list", () => {
  it("reports the newest verification of a backup whatever the location prefix sorts like", async () => {
    for (const location of ["kestrel-backups/", "zz-backups/"]) {
      const bucket = new MemoryBucket(`list-${location}`);
      const h = createHarness({ store: memoryStore(bucket), location });
      try {
        const id = backupId("prod", Date.parse("2026-11-14T12:00:00Z"), "manual", "00ab");
        bucket.write(location + keys.manifest(id), jsonBytes({ schema: "kestrel-ops/backup@1", id, versions: {} }), "put");
        bucket.write(`${location}backups/${id}/verify/20261114T120100Z-0001.json`, jsonBytes({ ok: true }), "put");
        bucket.write(`${location}backups/${id}/verify/20261114T130000Z-0002.json`, jsonBytes({ ok: false }), "put");
        const list = await h.run(["backup", "list", "--json"]);
        expect(list.json.backups, location).toMatchObject([{ id, verified: false }]);
      } finally {
        await h.dispose();
      }
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

describe("backup prune right after a backup the listing does not show yet", () => {
  it("keeps an object only that backup refers to, reused from an older backup, so the new backup stays restorable, and forgets backups older than a day", async () => {
    let now = Date.parse("2026-10-01T00:00:00Z");
    const bucket = new MemoryBucket("reuse-lag", { clock: () => now });
    const h = createHarness({ store: memoryStore(bucket) });
    const clock = { clock: () => now };
    try {
      h.editEnvironments((file) => {
        const backups = file.environments.prod?.backups;
        if (typeof backups === "object" && backups !== null) Reflect.set(backups, "retention", { cutover: 5, scheduled: 14, manual: 1, "pre-restore": 5 });
      });
      await h.app.start();
      await h.app.seed();
      expect((await h.run(["backup", "create", "--json"], clock)).code).toBe(0);
      await h.app.deleteMedia("m1");
      await h.app.sync();
      now += 60 * 60 * 1000;
      expect((await h.run(["backup", "create", "--json"], clock)).code).toBe(0);
      await h.app.upload("m1", "harbour.jpg", new TextEncoder().encode("harbour image bytes"));
      await h.app.sync();
      now += 2 * DAY;
      bucket.options.listLag = 3;
      const latest = await h.run(["backup", "create", "--json"], clock);
      expect(latest.code).toBe(0);
      const pruned = await h.run(["backup", "prune", "--yes", "--json"], clock);
      expect(pruned.code).toBe(0);
      expect(boundaryCast<string[]>(pruned.json.backups, "json")).toHaveLength(1);
      const recent = [...bucket.objects.keys()].filter((key) => key.startsWith(`${LOCATION}recent/`));
      expect(recent).toEqual([`${LOCATION}recent/20261003/000000.json`]);
      bucket.options.listLag = 0;
      const verified = await h.run(["backup", "verify", String(latest.json.id)]);
      expect(verified.stderr).toBe("");
      expect(verified.code).toBe(0);
    } finally {
      await h.dispose();
    }
  });
});
