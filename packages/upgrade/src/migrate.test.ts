import { createHash } from "node:crypto";
import dns from "node:dns";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err } from "@michaelthielemann/kestrel/result";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { runCli } from "./cli-run.ts";
import { runMigrateStep, type MigrateReport } from "./migrate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const FIXTURE = join(REPO, "fixtures", "upgrade", "5.8.1");
const PROJECT = join(REPO, "examples", "minimal");
const NOW = 1_800_000_000_000;
const MISSING = "8146a3f1-ee9b-4fbb-a394-290634519fd9";

const copies: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Copy {
  dir: string;
  db: string;
  blobs: string;
}

function fixtureCopy(): Copy {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-upgrade-migrate-"));
  copies.push(dir);
  copyFileSync(join(FIXTURE, "kestrel.db"), join(dir, "kestrel.db"));
  cpSync(join(FIXTURE, "blobs"), join(dir, "blobs"), { recursive: true });
  return { dir, db: join(dir, "kestrel.db"), blobs: join(dir, "blobs") };
}

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function rows(file: string, sql: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return boundaryCast<Array<Record<string, unknown>>>(db.prepare(sql).all(), "host");
  } finally {
    db.close();
  }
}

function state(copy: Copy): { media: unknown; variants: unknown; legacy: unknown; versions: unknown; blobs: Record<string, string> } {
  return {
    media: rows(copy.db, "SELECT id, key, filename, location, size, checksum, status FROM media_items ORDER BY id"),
    variants: rows(copy.db, "SELECT id, mediaId, size, slot, state FROM images_variants ORDER BY id"),
    legacy: rows(copy.db, "SELECT key, mediaId FROM media_legacy_keys ORDER BY key"),
    versions: rows(copy.db, "SELECT module, version, migrations FROM kestrel_storage_versions ORDER BY module"),
    blobs: files(copy.blobs),
  };
}

async function cli(argv: string[]): Promise<{ code: number; out: string; errors: string }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runCli(argv, { stdout: (l) => out.push(l), stderr: (l) => errors.push(l) });
  return { code, out: out.join("\n"), errors: errors.join("\n") };
}

function failingAfter(limit: number, calls: { n: number }): (method: string) => boolean {
  return () => {
    calls.n += 1;
    return calls.n > limit;
  };
}

function interposed<T extends object>(real: T, methods: readonly string[], fails: (method: string) => boolean): T {
  return new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      const method = boundaryCast<(...args: unknown[]) => unknown>(value, "host").bind(target);
      if (typeof prop !== "string" || !methods.includes(prop)) return method;
      return async (...args: unknown[]) => (fails(prop) ? err(failure("TRANSIENT", `interrupted at ${prop}`)) : method(...args));
    },
  });
}

describe("kestrel upgrade migrate: arguments and refusals", () => {
  it("needs both --db and --blobs-dir", async () => {
    const run = await cli(["migrate", "--root", PROJECT, "--db", "x.db"]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("migrate requires --db <sqlite file> and --blobs-dir <dir>");
  });

  it("refuses a database that does not pass quick_check and touches nothing", async () => {
    const copy = fixtureCopy();
    writeFileSync(copy.db, "not a database");
    const before = files(copy.blobs);
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("did not pass PRAGMA quick_check");
    expect(files(copy.blobs)).toEqual(before);
  });

  it("refuses a missing blob directory", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", join(copy.dir, "nowhere")]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("is not a directory");
  });
});

describe("kestrel upgrade migrate on the 5.8.1 data", () => {
  it("plans without converting a row or writing a blob", async () => {
    const copy = fixtureCopy();
    const pristine = fixtureCopy();
    const before = files(copy.blobs);
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--plan", "--json"]);
    expect(run.code).toBe(1);
    const report = boundaryCast<MigrateReport>(JSON.parse(run.out), "json");
    expect(report.applied).toBe(false);
    const media = report.modules.find((m) => m.module === "media/default")!;
    expect(media.state).toBe("pending");
    expect(media.migrations[0]).toMatchObject({ id: "media-default:id-key-layout", state: "pending", blocked: "plan-only" });
    expect(media.migrations[0]?.plan?.counts).toMatchObject({ items: 7, copies: 6, missingOriginals: 1 });
    expect(files(copy.blobs)).toEqual(before);
    expect(rows(copy.db, "SELECT id, key FROM media_items ORDER BY id")).toEqual(rows(pristine.db, "SELECT id, key FROM media_items ORDER BY id"));
  });

  it("converts the media and the variant rows, leaves the old blobs alone and runs past a lock file another process left", async () => {
    const copy = fixtureCopy();
    const sidecar = `${copy.db}.instance`;
    const lock = JSON.stringify({ host: "another-host", pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now(), ttlMs: 60_000 });
    writeFileSync(sidecar, lock);
    const before = files(copy.blobs);
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs]);
    expect(run.errors).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain("note: ");
    expect(run.out).toContain("media/default: migrated");
    expect(run.out).toContain("images/default: migrated");
    expect(readFileSync(sidecar, "utf8")).toBe(lock);

    const after = files(copy.blobs);
    for (const [path, sha] of Object.entries(before)) expect(after[path], path).toBe(sha);
    const media = rows(copy.db, "SELECT id, key, checksum, location, status FROM media_items");
    for (const row of media) {
      expect(String(row.key)).toMatch(new RegExp(`^media/${String(row.id)}/[^/]+$`));
      if (row.id === MISSING) continue;
      expect(after[String(row.key)], String(row.key)).toBe(row.checksum);
      expect(row.location).not.toBeNull();
    }
    const slots = rows(copy.db, "SELECT slot FROM images_variants").map((r) => r.slot);
    expect(slots.every((slot) => typeof slot === "string")).toBe(true);
    expect(new Set(slots).size).toBe(slots.length);
    expect(rows(copy.db, "SELECT module, version FROM kestrel_storage_versions ORDER BY module")).toEqual([
      { module: "images/default", version: "6.0.0" },
      { module: "media/default", version: "6.0.0" },
    ]);
  });

  it("does nothing on a second run", async () => {
    const copy = fixtureCopy();
    expect((await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs])).code).toBe(0);
    const once = state(copy);
    const again = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--json"]);
    expect(again.code).toBe(0);
    const report = boundaryCast<MigrateReport>(JSON.parse(again.out), "json");
    expect(report.modules.map((m) => [m.module, m.state, m.migrations.length])).toEqual([
      ["media/default", "current", 0],
      ["images/default", "current", 0],
    ]);
    expect(state(copy)).toEqual(once);
  });

  it("ends with the same data after runs that stop at three different places and a run that finishes", async () => {
    const clean = fixtureCopy();
    expect((await runMigrateStep({ dbFile: clean.db, blobsDir: clean.blobs, root: PROJECT, now: () => NOW })).exitCode).toBe(0);
    const expected = state(clean);

    const stops: Array<{ name: string; wrap: (stores: { db: Persistence; blobs: Blobstore }) => { db: Persistence; blobs: Blobstore } }> = [
      { name: "after the first copied blob", wrap: (s) => ({ db: s.db, blobs: interposed(s.blobs, ["put"], failingAfter(1, { n: 0 })) }) },
      { name: "after three switched items", wrap: (s) => ({ db: interposed(s.db, ["updateOne"], failingAfter(3, { n: 0 })), blobs: s.blobs }) },
      { name: "while filling in the variant slots", wrap: (s) => ({ db: interposed(s.db, ["updateMany", "deleteMany", "deleteOne"], failingAfter(0, { n: 0 })), blobs: s.blobs }) },
    ];
    const copy = fixtureCopy();
    const original = files(copy.blobs);
    for (const stop of stops) {
      const stopped = await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, now: () => NOW, wrap: stop.wrap });
      expect(stopped.exitCode, stop.name).toBe(2);
      expect(stopped.error, stop.name).toContain("running migrate again continues from here");
      const now = files(copy.blobs);
      for (const [path, sha] of Object.entries(original)) expect(now[path], `${stop.name}: ${path}`).toBe(sha);
    }
    const finished = await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, now: () => NOW });
    expect(finished.exitCode).toBe(0);
    expect(state(copy)).toEqual(expected);
  });

  it("moves an item whose original is missing to the trash when the answer says so", async () => {
    const copy = fixtureCopy();
    const answers = join(copy.dir, "answers.json");
    writeFileSync(answers, JSON.stringify({ "media-default:id-key-layout:missing-original": "trash" }));
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", answers]);
    expect(run.code).toBe(0);
    expect(rows(copy.db, `SELECT status, location FROM media_items WHERE id = '${MISSING}'`)).toEqual([{ status: "trashed", location: null }]);
  });

  it("opens no network connection", async () => {
    const attempts: string[] = [];
    const deny = (what: string) => (): never => {
      attempts.push(what);
      throw new Error(`network access attempted: ${what}`);
    };
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny("net.Socket.connect"));
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup"));
    vi.spyOn(dns.promises, "lookup").mockImplementation(deny("dns.promises.lookup"));
    vi.spyOn(http, "request").mockImplementation(deny("http.request"));
    vi.spyOn(https, "request").mockImplementation(deny("https.request"));
    vi.spyOn(globalThis, "fetch").mockImplementation(deny("fetch"));
    const copy = fixtureCopy();
    expect((await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--plan"])).code).toBe(1);
    expect((await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs])).code).toBe(0);
    expect((await cli(["data", "--root", PROJECT, "--db", copy.db])).code).toBe(0);
    expect(attempts).toEqual([]);
    expect(existsSync(join(copy.dir, "kestrel.db"))).toBe(true);
  });
});
