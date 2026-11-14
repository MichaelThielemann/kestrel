import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createBlobstoreFilesystem } from "../packages/blobstore-filesystem/impl.ts";
import { restoreFromBlobs } from "../packages/replication-sqlite/impl.ts";
import { boundaryCast } from "../packages/core/src/cast.ts";
import { isErr } from "../packages/core/src/result.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(ROOT, "scripts", "seed-upgrade-fixture.mjs");
const FIXTURE = join(ROOT, "fixtures", "upgrade", "5.8.1");
const BLOBS = join(FIXTURE, "blobs");

interface MediaEntry {
  id: string;
  key: string;
  folder: string;
  filename: string;
}

interface Manifest {
  version: string;
  password: { admin: string; editor: string };
  packages: Record<string, string>;
  media: Record<string, MediaEntry>;
  missingOriginal: string;
  duplicatedVariant: { mediaId: string; size: string; rows: number };
  pages: Record<string, string>;
  imageSizes: string[];
  collections: Record<string, number>;
  blobs: string[];
}

const manifest = boundaryCast<Manifest>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");
const scratch: string[] = [mkdtempSync(join(tmpdir(), "kestrel-fixture-db-"))];
copyFileSync(join(FIXTURE, "kestrel.db"), join(scratch[0] ?? "", "kestrel.db"));
const db = new DatabaseSync(join(scratch[0] ?? "", "kestrel.db"), { readOnly: true });

afterAll(() => {
  db.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function rows<T>(sql: string, ...params: Array<string | number>): T[] {
  return boundaryCast<T[]>(db.prepare(sql).all(...params), "host");
}

function count(file: DatabaseSync, table: string): number {
  return boundaryCast<{ n: number }>(file.prepare(`select count(*) as n from "${table}"`).get(), "host").n;
}

function tablesOf(): string[] {
  return rows<{ name: string }>("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name").map((row) => row.name);
}

function tree(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? tree(join(dir, entry.name), base) : [join(dir, entry.name).slice(base.length + 1)]));
}

interface MediaRow {
  id: string;
  filename: string;
  folder: string;
  key: string;
  status: string;
  checksum: string;
}

describe("the 5.8.1 upgrade fixture: provenance", () => {
  it("is generated from the published packages of one pinned release", () => {
    const source = readFileSync(GENERATOR, "utf8");
    expect(/export const VERSION = "([^"]+)"/.exec(source)?.[1]).toBe("5.8.1");
    expect(manifest.version).toBe("5.8.1");
    const kestrelPackages = Object.entries(manifest.packages).filter(([name]) => name.startsWith("@michaelthielemann/"));
    expect(kestrelPackages.length).toBeGreaterThan(20);
    for (const [name, version] of kestrelPackages) expect(version, name).toBe("5.8.1");
  });

  it("ships the database as one self-contained file", () => {
  it("removes its work directory when the run fails", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "kestrel-fixture-cleanup-"));
    scratch.push(sandbox);
    const work = join(sandbox, "tmp");
    mkdirSync(work);
    const run = spawnSync(process.execPath, [GENERATOR, "--out", join(sandbox, "out")], {
      env: { ...process.env, TMPDIR: work, npm_config_registry: "http://127.0.0.1:9/", npm_config_fetch_retries: "0", npm_config_fetch_retry_mintimeout: "100", npm_config_fetch_retry_maxtimeout: "100" },
      encoding: "utf8",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("seed-upgrade-fixture:");
    expect(readdirSync(work).filter((entry) => entry.startsWith("kestrel-upgrade-fixture-"))).toEqual([]);
  }, 60_000);

    expect(existsSync(join(FIXTURE, "kestrel.db"))).toBe(true);
    expect(existsSync(join(FIXTURE, "kestrel.db-wal"))).toBe(false);
    expect(existsSync(join(FIXTURE, "kestrel.db-shm"))).toBe(false);
    expect(rows<{ integrity_check: string }>("pragma integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("stays small and holds no file the generator does not list", () => {
    const files = tree(FIXTURE);
    expect(files.filter((file) => file.startsWith("blobs/")).map((file) => file.slice("blobs/".length)).sort()).toEqual([...manifest.blobs].sort());
    const bytes = files.reduce((sum, file) => sum + statSync(join(FIXTURE, file)).size, 0);
    expect(bytes).toBeLessThan(2_000_000);
    for (const file of files.filter((name) => name.startsWith("blobs/media/") && /\.(png|pdf|svg)$/.test(name))) expect(statSync(join(FIXTURE, file)).size).toBeLessThan(64 * 1024);
  });

  it("documents the demo credentials of its synthetic users", () => {
    expect(manifest.password).toEqual({ admin: "kestrel-demo", editor: "fixture-editor-pw" });
    const users = rows<{ username: string }>("select username from authn_users order by username").map((row) => row.username);
    expect(users).toEqual(["admin", "fixture-editor"]);
  });
});

describe("the 5.8.1 upgrade fixture: database", () => {
  it("has exactly the collections and row counts the generator recorded", () => {
    expect(tablesOf()).toEqual(Object.keys(manifest.collections).sort());
    for (const [table, expected] of Object.entries(manifest.collections)) expect(count(db, table), table).toBe(expected);
    expect(manifest.collections["media_items"]).toBeGreaterThanOrEqual(7);
    expect(manifest.collections["pages"]).toBeGreaterThanOrEqual(4);
  });

  it("keeps the same filename in two folders as two items with their own blobs", () => {
    const same = rows<MediaRow>("select * from media_items where filename = ?", "photo.png");
    expect(same).toHaveLength(2);
    expect(new Set(same.map((row) => row.folder)).size).toBe(2);
    expect(new Set(same.map((row) => row.key)).size).toBe(2);
    expect(new Set(same.map((row) => row.checksum)).size).toBe(2);
    for (const row of same) expect(existsSync(join(BLOBS, row.key)), row.key).toBe(true);
  });

  it("nests folders and keeps an empty one", () => {
    const folders = rows<{ path: string }>("select path from media_folders order by path").map((row) => row.path);
    expect(folders).toContain("gallery/2026/summer");
    expect(folders).toContain("archive");
    expect(rows<MediaRow>("select * from media_items where folder = ?", "archive")).toHaveLength(0);
    expect(rows<MediaRow>("select * from media_items where folder = ?", "gallery/2026/summer")).toHaveLength(1);
  });

  it("holds one ready item whose original is gone and no other", () => {
    const items = rows<MediaRow>("select * from media_items");
    const lost = items.filter((row) => !existsSync(join(BLOBS, row.key)));
    expect(lost.map((row) => row.id)).toEqual([manifest.missingOriginal]);
    expect(lost[0]?.status).toBe("ready");
  });

  it("stores a key per item that mirrors folder and filename", () => {
    for (const row of rows<MediaRow>("select * from media_items")) expect(row.key).toBe(row.folder === "" ? `media/${row.filename}` : `media/${row.folder}/${row.filename}`);
  });

  it("records the sha256 of every original that is present", () => {
    const present = rows<MediaRow>("select * from media_items").filter((row) => existsSync(join(BLOBS, row.key)));
    expect(present.length).toBeGreaterThanOrEqual(6);
    for (const row of present) expect(createHash("sha256").update(readFileSync(join(BLOBS, row.key))).digest("hex"), row.key).toBe(row.checksum);
  });

  it("is protected from line-ending conversion on checkout", () => {
    expect(readFileSync(join(ROOT, ".gitattributes"), "utf8").split("\n")).toContain("fixtures/** -text");
  });

  it("has variants in three sizes whose files exist", () => {
    const variants = rows<{ size: string; key: string }>("select size, key from images_variants");
    expect([...new Set(variants.map((row) => row.size))].sort()).toEqual([...manifest.imageSizes].sort());
    expect(manifest.imageSizes).toHaveLength(3);
    for (const row of variants) expect(existsSync(join(BLOBS, row.key)), row.key).toBe(true);
  });

  it("has duplicate variant rows for one medium and size", () => {
    const duplicated = rows<{ mediaId: string; size: string; n: number }>("select mediaId, size, count(*) as n from images_variants group by mediaId, size having n > 1");
    expect(duplicated).toEqual([{ mediaId: manifest.duplicatedVariant.mediaId, size: manifest.duplicatedVariant.size, n: manifest.duplicatedVariant.rows }]);
  });

  it("has revisions whose snapshots refer to media", () => {
    const mediaIds = new Set(rows<{ id: string }>("select id from media_items").map((row) => row.id));
    const withMedia = rows<{ snapshot: string }>("select snapshot from revisions_entries where snapshot is not null").filter((row) => [...mediaIds].some((id) => row.snapshot.includes(id)));
    expect(withMedia.length).toBeGreaterThanOrEqual(3);
    expect(rows<{ label: string }>("select label from revisions_entries where label is not null")).toHaveLength(1);
  });

  it("has a published and a draft page in two languages", () => {
    const statuses = rows<{ status__de: string | null; status__en: string | null }>("select status__de, status__en from pages");
    expect(statuses.some((row) => row.status__de === "published")).toBe(true);
    expect(statuses.some((row) => row.status__de === "draft")).toBe(true);
    expect(statuses.some((row) => row.status__en === "published")).toBe(true);
  });
});

describe("the 5.8.1 upgrade fixture: blob tree", () => {
  it("covers every key family a 5.8.1 instance writes", () => {
    const families: Array<[string, RegExp]> = [
      ["original", /^media\/(?:[^/]+\/)*[^/]+\.(?:png|pdf|svg)$/],
      ["nested original", /^media\/gallery\/2026\/summer\/beach\.png$/],
      ["variant", /^media-variants\/[0-9a-f-]{36}\/(?:thumb|small)\.webp$/],
      ["variant in the original format", /^media-variants\/[0-9a-f-]{36}\/wide\.png$/],
      ["rendered page", /^site\/(?:[a-z-]+\/)?index\.html$/],
      ["rendered page, second language", /^site\/en\/index\.html$/],
      ["llms.txt", /^site\/llms\.txt$/],
      ["llms-full.txt", /^site\/llms-full\.txt$/],
      ["redirect rules", /^site\/redirects\.json$/],
      ["exported media original", /^site\/media\/(?:[^/]+\/)*[^/]+\.(?:png|pdf|svg)$/],
      ["exported media original in a nested folder", /^site\/media\/gallery\/2026\/summer\/beach\.png$/],
      ["exported media variant", /^site\/media\/(?:[^/]+\/)*[^/]+\.(?:thumb|small)\.webp$/],
      ["exported media variant in the original format", /^site\/media\/(?:[^/]+\/)*[^/]+\.wide\.png$/],
      ["backup", /^backups\/kestrel\.db$/],
      ["backup version", /^backups\/kestrel\.db\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/],
      ["replica snapshot", /^replica\/gen\/[0-9]{8}T[0-9]{6}Z\/snapshot\.db$/],
      ["replica segment", /^replica\/gen\/[0-9]{8}T[0-9]{6}Z\/wal\/[0-9]{6}-[0-9]{6}-[0-9]{8}T[0-9]{6}Z\.wal$/],
    ];
    for (const [label, pattern] of families) expect(keys("").some((key) => pattern.test(key)), label).toBe(true);
  });

  it("holds no other key family", () => {
    for (const key of keys("")) expect(/^(?:media|media-variants|site|replica|backups)\//.test(key), key).toBe(true);
  });

  it("exports the same filename from two folders as two separate copies of the right originals", () => {
    const photos = rows<MediaRow>("select * from media_items where filename = ?", "photo.png");
    expect(photos).toHaveLength(2);
    const copies = photos.map((row) => `site/media/${row.folder}/${row.filename}`);
    expect(new Set(copies).size).toBe(2);
    for (const [index, row] of photos.entries()) {
      const copy = readFileSync(join(BLOBS, copies[index] ?? ""));
      expect(copy.equals(readFileSync(join(BLOBS, row.key))), copies[index]).toBe(true);
    }
  });

  it("copies every exported media file from the original or variant its key names", () => {
    const items = rows<MediaRow>("select * from media_items");
    const variants = rows<{ mediaId: string; size: string; key: string }>("select mediaId, size, key from images_variants");
    const exported = keys("site/media/");
    expect(exported.length).toBeGreaterThanOrEqual(8);
    for (const key of exported) {
      const rest = key.slice("site/media/".length);
      const original = items.find((row) => `${row.folder === "" ? "" : `${row.folder}/`}${row.filename}` === rest);
      if (original !== undefined) {
        expect(readFileSync(join(BLOBS, key)).equals(readFileSync(join(BLOBS, original.key))), key).toBe(true);
        continue;
      }
      const variant = items.flatMap((row) => variants.filter((v) => v.mediaId === row.id && rest.startsWith(`${row.folder === "" ? "" : `${row.folder}/`}${row.filename}.${v.size}.`)));
      expect(variant.length, key).toBeGreaterThan(0);
      expect(readFileSync(join(BLOBS, key)).equals(readFileSync(join(BLOBS, variant[0]?.key ?? ""))), key).toBe(true);
    }
  });

  it("links the exported pages to the exported media files and leaves no media id in a url", () => {
    const html = readFileSync(join(BLOBS, "site", "about", "index.html"), "utf8");
    expect(html).toContain("/media/gallery/photo.png");
    expect(html).toContain("/media/team/photo.png");
    for (const key of keys("site/").filter((name) => name.endsWith(".html"))) expect(readFileSync(join(BLOBS, key), "utf8"), key).not.toMatch(/\/media\/[0-9a-f-]{36}\//);
  });

  it("holds a backup of the database and at least two versions of it", () => {
    const database = readFileSync(join(FIXTURE, "kestrel.db"));
    expect(readFileSync(join(BLOBS, "backups", "kestrel.db")).equals(database)).toBe(true);
    const versions = keys("backups/kestrel.db.");
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (const key of versions) expect(readFileSync(join(BLOBS, key)).equals(database), key).toBe(true);
  });
});

describe("the 5.8.1 upgrade fixture: replica", () => {
  it("consists of one snapshot and segments of more than one write-ahead log lineage", () => {
    const replica = keys("replica/").filter((key) => key.endsWith(".wal") || key.endsWith("snapshot.db"));
    expect(replica.filter((key) => key.endsWith("snapshot.db"))).toHaveLength(1);
    const segments = replica.filter((key) => key.endsWith(".wal")).map((key) => /\/(\d{6})-(\d{6})-/.exec(key)?.slice(1, 3));
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(new Set(segments.map((segment) => segment?.[0])).size).toBeGreaterThanOrEqual(2);
  });

  it("restores to the database that was shipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kestrel-fixture-restore-"));
    scratch.push(dir);
    const out = join(dir, "restored.db");
    const restored = await restoreFromBlobs(createBlobstoreFilesystem({ root: BLOBS }), "replica/", {}, out);
    expect(isErr(restored) ? restored.error.message : "ok").toBe("ok");

    const copy = new DatabaseSync(out, { readOnly: true });
    try {
      expect(boundaryCast<Array<{ integrity_check: string }>>(copy.prepare("pragma integrity_check").all(), "host")).toEqual([{ integrity_check: "ok" }]);
      expect(boundaryCast<Array<{ name: string }>>(copy.prepare("select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name").all(), "host").map((row) => row.name)).toEqual(tablesOf());
      const dump = (file: DatabaseSync, table: string): string => JSON.stringify(file.prepare(`select * from "${table}" order by rowid`).all());
      for (const table of tablesOf()) expect(dump(copy, table), table).toBe(dump(db, table));
      const ids = (file: DatabaseSync): string[] => boundaryCast<Array<{ id: string }>>(file.prepare("select id from media_items order by id").all(), "host").map((row) => row.id);
      expect(ids(copy)).toEqual(ids(db));
    } finally {
      copy.close();
    }
  });
});

function keys(prefix: string): string[] {
  return manifest.blobs.filter((key) => key.startsWith(prefix));
}
