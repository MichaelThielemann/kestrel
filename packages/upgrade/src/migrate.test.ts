import { createHash } from "node:crypto";
import dns from "node:dns";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import type { LoadedProject, UpgradePlugin } from "./plugin.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const FIXTURE = join(REPO, "fixtures", "upgrade", "5.8.1");
const PROJECT = join(REPO, "examples", "minimal");
const NOW = 1_800_000_000_000;
const MISSING = "8146a3f1-ee9b-4fbb-a394-290634519fd9";
const MISSING_ORIGINAL = "media-default:id-key-layout:missing-original";
const KEEP = { [MISSING_ORIGINAL]: "keep" };

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

function keepFile(copy: Copy): string {
  const file = join(copy.dir, "answers.json");
  writeFileSync(file, JSON.stringify(KEEP));
  return file;
}

function tableRows(file: string, table: string): Array<Record<string, unknown>> {
  return rows(file, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`).length === 0 ? [] : rows(file, `SELECT * FROM "${table}"`);
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

async function cli(argv: string[], plugins: readonly UpgradePlugin[] = []): Promise<{ code: number; out: string; errors: string }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runCli(argv, { stdout: (l) => out.push(l), stderr: (l) => errors.push(l), plugins });
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

  it("says that the directory of a sound database needs room and write access when SQLite cannot open it, without calling the copy inconsistent", async () => {
    const copy = fixtureCopy();
    const sealed = join(copy.dir, "sealed");
    mkdirSync(sealed);
    const db = join(sealed, "kestrel.db");
    copyFileSync(copy.db, db);
    chmodSync(sealed, 0o555);
    try {
      const before = files(copy.blobs);
      const run = await cli(["migrate", "--root", PROJECT, "--db", db, "--blobs-dir", copy.blobs]);
      expect(run.code).toBe(2);
      expect(run.errors).toContain("could not be opened");
      expect(run.errors).toContain("free space and write access");
      expect(run.errors).not.toContain("did not pass PRAGMA quick_check");
      expect(run.errors).not.toContain("take a consistent copy");
      expect(files(copy.blobs)).toEqual(before);
    } finally {
      chmodSync(sealed, 0o755);
    }
  });

  it("refuses a missing blob directory", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", join(copy.dir, "nowhere")]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("is not a directory");
  });
});

const FILES_PREFIX_MODULES = `[
  { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./data/blobs" } },
  { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: "./data/kestrel.db" } },
  { use: "@michaelthielemann/kestrel-media-default", config: { prefix: "files/" } },
  { use: "@michaelthielemann/kestrel-images-default", config: {} },
]`;

function projectWith(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kestrel-upgrade-migrate-project-"));
  copies.push(dir);
  copyFileSync(join(PROJECT, "package.json"), join(dir, "package.json"));
  symlinkSync(join(PROJECT, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(join(dir, "kestrel.config.ts"), config);
  return dir;
}

function failingConfigProject(): string {
  return projectWith(`import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";
if (process.env.KESTREL_MIGRATE_TEST_SETTING !== "on") throw new Error("KESTREL_MIGRATE_TEST_SETTING is not set");
export default defineConfig({ modules: ${FILES_PREFIX_MODULES} });
`);
}

function filesPrefixPlugin(): UpgradePlugin {
  const project = { kind: "test-host", configFile: "kestrel.config.ts", moduleFiles: new Map(), pipelineFiles: [], input: { config: { modules: [{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "files/" } }], triggers: [] }, modules: [], pipelines: [] } };
  return { kind: "test-host", detect: () => true, load: () => Promise.resolve({ project: boundaryCast<LoadedProject>(project, "host"), issues: [] }) };
}

function keysOf(copy: Copy): string[] {
  return rows(copy.db, "SELECT id, key FROM media_items ORDER BY id").map((r) => String(r.key).replace(String(r.id), "<id>"));
}

describe("kestrel upgrade migrate: the module config it converts with", () => {
  it("stops when kestrel.config.ts exists but does not load, names the error and converts nothing", async () => {
    const copy = fixtureCopy();
    const pristine = fixtureCopy();
    const before = files(copy.blobs);
    const run = await cli(["migrate", "--root", failingConfigProject(), "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("KESTREL_MIGRATE_TEST_SETTING is not set");
    expect(run.errors).toContain("--media-prefix");
    expect(files(copy.blobs)).toEqual(before);
    expect(rows(copy.db, "SELECT id, key FROM media_items ORDER BY id")).toEqual(rows(pristine.db, "SELECT id, key FROM media_items ORDER BY id"));
  });

  it("takes the media prefix from kestrel.config.ts and names it in a note", async () => {
    const copy = fixtureCopy();
    const root = projectWith(`import { defineConfig } from "@michaelthielemann/kestrel/defineConfig";
export default defineConfig({ modules: ${FILES_PREFIX_MODULES} });
`);
    const run = await cli(["migrate", "--root", root, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)]);
    expect(run.code, run.errors).toBe(0);
    expect(run.out).toContain('note: media/default converts to the key prefix "files/" from kestrel.config.ts');
    expect(keysOf(copy).every((key) => key.startsWith("files/<id>/"))).toBe(true);
  });

  it("takes the module config from the host plugin when kestrel.config.ts does not load by itself", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", failingConfigProject(), "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)], [filesPrefixPlugin()]);
    expect(run.code, run.errors).toBe(0);
    expect(run.out).toContain('note: media/default converts to the key prefix "files/" from the "test-host" plugin');
    expect(keysOf(copy).every((key) => key.startsWith("files/<id>/"))).toBe(true);
  });

  it("refuses a --media-prefix that media-default would not accept", async () => {
    const copy = fixtureCopy();
    for (const prefix of ["media", "/media/", ""]) {
      const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--media-prefix", prefix]);
      expect(run.code, prefix).toBe(2);
      expect(run.errors, prefix).toContain('--media-prefix must be one or more "<segment>/" parts');
    }
  });

  it("converts with the prefix --media-prefix names, whether or not the config loads", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", failingConfigProject(), "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy), "--media-prefix", "files/"]);
    expect(run.code, run.errors).toBe(0);
    expect(run.out).toContain('note: media/default converts to the key prefix "files/" from --media-prefix');
    expect(keysOf(copy).every((key) => key.startsWith("files/<id>/"))).toBe(true);
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
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)]);
    expect(run.errors).toBe("");
    expect(run.code).toBe(0);
    expect(run.out).toContain(`note: ${sidecar} exists`);
    expect(run.out).toContain('note: media/default converts to the key prefix "media/" from kestrel.config.ts');
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
    expect((await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)])).code).toBe(0);
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
    expect((await runMigrateStep({ dbFile: clean.db, blobsDir: clean.blobs, root: PROJECT, answers: KEEP, now: () => NOW })).exitCode).toBe(0);
    const expected = state(clean);

    const stops: Array<{ name: string; wrap: (stores: { db: Persistence; blobs: Blobstore }) => { db: Persistence; blobs: Blobstore } }> = [
      { name: "after the first copied blob", wrap: (s) => ({ db: s.db, blobs: interposed(s.blobs, ["put"], failingAfter(1, { n: 0 })) }) },
      { name: "after three switched items", wrap: (s) => ({ db: interposed(s.db, ["updateOne"], failingAfter(3, { n: 0 })), blobs: s.blobs }) },
      { name: "while filling in the variant slots", wrap: (s) => ({ db: interposed(s.db, ["updateMany", "deleteMany", "deleteOne"], failingAfter(0, { n: 0 })), blobs: s.blobs }) },
    ];
    const copy = fixtureCopy();
    const original = files(copy.blobs);
    for (const stop of stops) {
      const stopped = await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, answers: KEEP, now: () => NOW, wrap: stop.wrap });
      expect(stopped.exitCode, stop.name).toBe(2);
      expect(stopped.error, stop.name).toContain("running migrate again continues from here");
      const now = files(copy.blobs);
      for (const [path, sha] of Object.entries(original)) expect(now[path], `${stop.name}: ${path}`).toBe(sha);
    }
    const finished = await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, answers: KEEP, now: () => NOW });
    expect(finished.exitCode).toBe(0);
    expect(state(copy)).toEqual(expected);
  });

  it("answers exit code 2 and how to continue when the blob store throws, and a later run finishes the conversion", async () => {
    const clean = fixtureCopy();
    expect((await runMigrateStep({ dbFile: clean.db, blobsDir: clean.blobs, root: PROJECT, answers: KEEP, now: () => NOW })).exitCode).toBe(0);
    const expected = state(clean);
    const copy = fixtureCopy();
    const throwing = (blobs: Blobstore): Blobstore =>
      new Proxy(blobs, {
        get(target, prop) {
          if (prop === "put") return () => Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === "function" ? boundaryCast<(...args: unknown[]) => unknown>(value, "host").bind(target) : value;
        },
      });
    const stopped = await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, answers: KEEP, now: () => NOW, wrap: (s) => ({ db: s.db, blobs: throwing(s.blobs) }) });
    expect(stopped.exitCode).toBe(2);
    expect(stopped.error).toContain("ENOSPC: no space left on device");
    expect(stopped.error).toContain("running migrate again continues from here");
    expect((await runMigrateStep({ dbFile: copy.db, blobsDir: copy.blobs, root: PROJECT, answers: KEEP, now: () => NOW })).exitCode).toBe(0);
    expect(state(copy)).toEqual(expected);
  });

  it("refuses to switch an item whose original it cannot find until the answers say keep or trash, and converts nothing", async () => {
    const copy = fixtureCopy();
    const pristine = fixtureCopy();
    const before = files(copy.blobs);
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs]);
    expect(run.code).toBe(2);
    expect(run.errors).toContain("1 of 7 item(s) of media/default have no original");
    expect(run.errors).toContain(MISSING);
    expect(run.errors).toContain(MISSING_ORIGINAL);
    expect(files(copy.blobs)).toEqual(before);
    expect(rows(copy.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id")).toEqual(rows(pristine.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id"));
    expect(tableRows(copy.db, "kestrel_storage_versions")).toEqual([]);
    expect(tableRows(copy.db, "media_legacy_keys")).toEqual([]);
  });

  it("refuses a --blobs-dir under which no original is found, even one directory too deep, and converts nothing", async () => {
    const copy = fixtureCopy();
    const pristine = fixtureCopy();
    const before = files(copy.blobs);
    for (const blobsDir of [join(copy.blobs, "media"), join(copy.dir, "empty")]) {
      mkdirSync(blobsDir, { recursive: true });
      const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", blobsDir]);
      expect(run.code, blobsDir).toBe(2);
      expect(run.errors, blobsDir).toContain("7 of 7 item(s) of media/default have no original");
      expect(run.errors, blobsDir).toContain("none of the originals is there");
    }
    expect(files(copy.blobs)).toEqual(before);
    expect(rows(copy.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id")).toEqual(rows(pristine.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id"));
    expect(tableRows(copy.db, "kestrel_storage_versions")).toEqual([]);
  });

  it("refuses a --blobs-dir under which no original is found also when the answers say keep or trash, and converts nothing", async () => {
    const copy = fixtureCopy();
    const pristine = fixtureCopy();
    const before = files(copy.blobs);
    for (const answer of ["keep", "trash"]) {
      const answers = join(copy.dir, `${answer}.json`);
      writeFileSync(answers, JSON.stringify({ [MISSING_ORIGINAL]: answer }));
      for (const blobsDir of [join(copy.blobs, "media"), join(copy.dir, "empty")]) {
        mkdirSync(blobsDir, { recursive: true });
        const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", blobsDir, "--answers", answers]);
        expect(run.code, `${answer} ${blobsDir}`).toBe(2);
        expect(run.errors, `${answer} ${blobsDir}`).toContain("7 of 7 item(s) of media/default have no original");
        expect(run.errors, `${answer} ${blobsDir}`).toContain("none of the originals is there");
        expect(run.errors, `${answer} ${blobsDir}`).toContain("nothing was converted");
      }
    }
    expect(files(copy.blobs)).toEqual(before);
    expect(rows(copy.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id")).toEqual(rows(pristine.db, "SELECT id, key, filename, size, checksum, status FROM media_items ORDER BY id"));
    expect(tableRows(copy.db, "kestrel_storage_versions")).toEqual([]);
    expect(tableRows(copy.db, "media_legacy_keys")).toEqual([]);
  });

  it("names a --blobs-dir without any original in a plan also when the answers say keep", async () => {
    const copy = fixtureCopy();
    const empty = join(copy.dir, "empty");
    mkdirSync(empty);
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", empty, "--plan", "--answers", keepFile(copy)]);
    expect(run.code).toBe(1);
    expect(run.out).toContain("none of the originals is there");
  });

  it("names the missing originals in a plan and that applying needs an answer for them", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--plan"]);
    expect(run.code).toBe(1);
    expect(run.out).toContain(`note: 1 of 7 item(s) of media/default have no original`);
    expect(run.out).toContain(MISSING_ORIGINAL);
  });

  it("keeps an item whose original is missing when the answer says so", async () => {
    const copy = fixtureCopy();
    const run = await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)]);
    expect(run.code).toBe(0);
    expect(rows(copy.db, `SELECT status FROM media_items WHERE id = '${MISSING}'`)).toEqual([{ status: "ready" }]);
    expect(String(rows(copy.db, `SELECT key FROM media_items WHERE id = '${MISSING}'`)[0]?.key)).toMatch(new RegExp(`^media/${MISSING}/`));
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
    expect((await cli(["migrate", "--root", PROJECT, "--db", copy.db, "--blobs-dir", copy.blobs, "--answers", keepFile(copy)])).code).toBe(0);
    expect((await cli(["data", "--root", PROJECT, "--db", copy.db])).code).toBe(0);
    expect(attempts).toEqual([]);
    expect(existsSync(join(copy.dir, "kestrel.db"))).toBe(true);
  });
});
