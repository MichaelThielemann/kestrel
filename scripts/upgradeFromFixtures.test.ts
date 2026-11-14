import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boot, definePipeline, type Kestrel } from "../packages/core/src/index.ts";
import { boundaryCast } from "../packages/core/src/cast.ts";
import { loadConfig, loadModules, loadPipelines } from "../packages/core/src/load.ts";
import type { KestrelConfigInput } from "../packages/core/src/defineConfig.ts";
import { runUpgradeCli } from "../packages/upgrade/src/plugin.ts";
import type { UpgradeReport } from "../packages/upgrade/src/report.ts";
import type { MigrateReport } from "../packages/upgrade/src/migrate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "fixtures", "upgrade", "5.8.1");
const PROJECT = join(ROOT, "examples", "minimal");

interface Manifest {
  password: { admin: string };
  media: Record<string, { id: string; key: string }>;
  missingOriginal: string;
  duplicatedVariant: { mediaId: string; size: string; rows: number };
  config: { images: { sizes: unknown[] } };
  collections: Record<string, number>;
}

const manifest = boundaryCast<Manifest>(JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8")), "json");
const trigger = { kind: "http", name: "test" } as const;
const work = mkdtempSync(join(tmpdir(), "kestrel-upgrade-from-fixture-"));
const db = join(work, "kestrel.db");
const blobs = join(work, "blobs");
const sidecar = `${db}.instance`;
const leftoverLock = JSON.stringify({ host: "stopped-instance", pid: 4242, startedAt: Date.now() - 60_000, heartbeatAt: Date.now(), ttlMs: 60_000 });

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function query(sql: string): Array<Record<string, unknown>> {
  const handle = new DatabaseSync(db, { readOnly: true });
  try {
    return boundaryCast<Array<Record<string, unknown>>>(handle.prepare(sql).all(), "host");
  } finally {
    handle.close();
  }
}

function databaseState(): Record<string, unknown> {
  const tables = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => String(r.name));
  return Object.fromEntries(tables.map((table) => [table, query(`SELECT * FROM "${table}" ORDER BY id`)]));
}

async function cli(argv: string[]): Promise<{ code: number; out: string; errors: string }> {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runUpgradeCli(argv, { stdout: (l) => out.push(l), stderr: (l) => errors.push(l) });
  return { code, out: out.join("\n"), errors: errors.join("\n") };
}

async function bootConverted(): Promise<{ kestrel: Kestrel; base: string }> {
  const input = await loadConfig(join(PROJECT, "kestrel.config.ts"));
  const modules = input.modules.map((m) => {
    const config = boundaryCast<Record<string, unknown>>(m.config ?? {}, "host");
    if (m.use === "@michaelthielemann/kestrel-blobstore-filesystem") return { ...m, config: { ...config, root: blobs } };
    if (m.use === "@michaelthielemann/kestrel-persistence-sqlite" || m.use === "@michaelthielemann/kestrel-replication-sqlite") return { ...m, config: { ...config, file: db } };
    if (m.use === "@michaelthielemann/kestrel-images-default") return { ...m, config: { ...config, sizes: manifest.config.images.sizes } };
    return m;
  });
  const http = boundaryCast<Record<string, unknown>>(input.http ?? {}, "host");
  const config: KestrelConfigInput = { ...input, http: { ...http, port: 0, host: "127.0.0.1" }, modules, triggers: input.triggers.filter((t) => !("cron" in t)) };
  const loaded = await loadModules(PROJECT, config);
  const pipelines = [...(await loadPipelines(PROJECT, "pipelines")), definePipeline({ name: "reconcileForUpgradeCheck", steps: ["media.reconcile"] })];
  const kestrel = await boot({ config, modules: loaded, pipelines, root: PROJECT });
  const started = await kestrel.start();
  if (started.http === undefined) throw new Error("the HTTP server did not start");
  return { kestrel, base: `http://127.0.0.1:${started.http.port}` };
}

function mediaUrls(html: string): string[] {
  const text = html.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll('\\"', '"');
  return [...text.matchAll(/["'(\s](\/media\/[^"'()\s<>\\]+)/g)].map((m) => m[1]!);
}

let fixtureBefore: Record<string, string>;
let originalsBefore: Record<string, string>;
let migratedState: { database: Record<string, unknown>; blobs: Record<string, string> };
let typesBefore: Map<string, string>;

beforeAll(() => {
  fixtureBefore = files(FIXTURE);
  copyFileSync(join(FIXTURE, "kestrel.db"), db);
  cpSync(join(FIXTURE, "blobs"), blobs, { recursive: true });
  originalsBefore = files(blobs);
  typesBefore = new Map(query("SELECT id, contentType FROM media_items").map((r) => [String(r.id), String(r.contentType)]));
  writeFileSync(sidecar, leftoverLock);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("upgrading the data of 5.8.1 to this release", () => {
  it("converts a copy with kestrel upgrade migrate once the missing original is answered, past the lock file of the stopped instance", async () => {
    const unanswered = await cli(["migrate", "--root", PROJECT, "--db", db, "--blobs-dir", blobs, "--json"]);
    expect(unanswered.code).toBe(2);
    expect(unanswered.errors).toContain(manifest.missingOriginal);
    expect(unanswered.errors).toContain("nothing was converted");
    expect(files(blobs)).toEqual(originalsBefore);
    const answers = join(work, "answers.json");
    writeFileSync(answers, JSON.stringify({ "media-default:id-key-layout:missing-original": "keep" }));
    const run = await cli(["migrate", "--root", PROJECT, "--db", db, "--blobs-dir", blobs, "--answers", answers, "--json"]);
    expect(run.code, run.errors).toBe(0);
    const report = boundaryCast<MigrateReport>(JSON.parse(run.out), "json");
    expect(report.modules.map((m) => [m.module, m.state])).toEqual([
      ["media/default", "migrated"],
      ["images/default", "migrated"],
    ]);
    const svgIds = [...typesBefore].filter(([, type]) => type === "image/svg+xml").map(([id]) => id);
    expect(svgIds.length).toBeGreaterThan(0);
    const layout = report.modules.flatMap((m) => m.migrations).find((m) => m.id === "media-default:id-key-layout");
    expect(layout?.outcome?.counts.svgDemoted).toBe(svgIds.length);
    for (const id of svgIds) expect(layout?.outcome?.notes.find((n) => n.item === id)?.reason).toContain("application/octet-stream");
    expect(run.errors).toContain(".instance exists");
    expect(readFileSync(sidecar, "utf8")).toBe(leftoverLock);

    const after = files(blobs);
    for (const [path, sha] of Object.entries(originalsBefore)) expect(after[path], `${path} is left as it was`).toBe(sha);
    for (const row of query("SELECT id, key, checksum, location FROM media_items")) {
      expect(String(row.key)).toMatch(new RegExp(`^media/${String(row.id)}/[^/]+$`));
      if (row.id === manifest.missingOriginal) continue;
      expect(after[String(row.key)], `the copy at ${String(row.key)} has the item's checksum`).toBe(row.checksum);
      expect(row.location).not.toBeNull();
    }
    const slots = query("SELECT slot FROM images_variants").map((r) => r.slot);
    expect(slots.every((slot) => typeof slot === "string")).toBe(true);
    expect(new Set(slots).size).toBe(slots.length);
    const { mediaId, size, rows } = manifest.duplicatedVariant;
    expect(query(`SELECT COUNT(*) AS n FROM images_variants WHERE mediaId = '${mediaId}' AND size = '${size}'`)).toEqual([{ n: 1 }]);
    for (const [table, count] of Object.entries(manifest.collections)) {
      const expected = table === "images_variants" ? count - (rows - 1) : count;
      expect(query(`SELECT COUNT(*) AS n FROM "${table}"`), table).toEqual([{ n: expected }]);
    }
    migratedState = { database: databaseState(), blobs: after };
  });

  it("finds nothing to plan or write on a second run", async () => {
    const plan = await cli(["migrate", "--root", PROJECT, "--db", db, "--blobs-dir", blobs, "--plan", "--json"]);
    expect(plan.code).toBe(0);
    expect(boundaryCast<MigrateReport>(JSON.parse(plan.out), "json").modules.map((m) => [m.module, m.state, m.migrations.length])).toEqual([
      ["media/default", "current", 0],
      ["images/default", "current", 0],
    ]);
    const again = await cli(["migrate", "--root", PROJECT, "--db", db, "--blobs-dir", blobs, "--json"]);
    expect(again.code).toBe(0);
    expect(boundaryCast<MigrateReport>(JSON.parse(again.out), "json").modules.every((m) => m.state === "current" && m.migrations.length === 0)).toBe(true);
    expect({ database: databaseState(), blobs: files(blobs) }).toEqual(migratedState);
  });

  it("leaves kestrel upgrade data with no error on the converted copy", async () => {
    const run = await cli(["data", "--root", PROJECT, "--db", db, "--json"]);
    expect(run.code, run.errors).toBe(0);
    const report = boundaryCast<UpgradeReport>(JSON.parse(run.out), "json");
    expect(report.summary.error).toBe(0);
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("boots this release on the converted copy, serves every media URL of the exported pages and reports only the old keys as orphaned", async () => {
    rmSync(sidecar);
    const { kestrel, base } = await bootConverted();
    try {
      const reconcile = await kestrel.run("reconcileForUpgradeCheck", { trigger, payload: {} });
      expect(reconcile.status).toBe(200);
      const missing = Object.values(manifest.media).find((m) => m.id === manifest.missingOriginal)!;
      const oldKeys = Object.values(manifest.media).filter((m) => m.id !== manifest.missingOriginal).map((m) => m.key).sort();
      expect(reconcile.result).toEqual({ blobsWithoutRow: [], rowsWithoutBlob: [`media/${missing.id}/${missing.key.split("/").at(-1) ?? ""}`], legacyKeys: oldKeys });

      const synced = await kestrel.run("syncPublicMedia", { trigger, payload: {} });
      expect(synced.status).toBe(200);
      const login = await kestrel.run("login", { trigger, payload: { username: "admin", password: manifest.password.admin } });
      const headers = { authorization: `Bearer ${boundaryCast<{ token: string }>(login.result, "json").token}` };
      const published = await kestrel.run("publishAllPages", { trigger, headers, payload: {} });
      expect(published.status).toBe(200);
      expect(published.result).toMatchObject({ errors: 0 });

      const pages = Object.entries(files(join(blobs, "site"))).filter(([path]) => path.endsWith(".html")).map(([path]) => path);
      expect(pages.length).toBeGreaterThanOrEqual(4);
      const urls = [...new Set(pages.flatMap((page) => mediaUrls(readFileSync(join(blobs, "site", page), "utf8"))))].sort();
      expect(urls.some((url) => url.includes("/variants/"))).toBe(true);
      expect(urls.some((url) => !url.includes("/variants/"))).toBe(true);
      const svgIds = [...typesBefore].filter(([, type]) => type === "image/svg+xml").map(([id]) => id);
      expect(urls.filter((url) => svgIds.some((id) => url.startsWith(`/media/${id}/`)) && !url.includes("/variants/")).length).toBeGreaterThan(0);
      for (const url of urls) {
        const response = await fetch(`${base}${url}`);
        expect(response.status, url).toBe(200);
        await response.arrayBuffer();
        const type = response.headers.get("content-type") ?? "";
        const original = typesBefore.get(url.split("/")[2] ?? "");
        if (url.includes("/variants/")) expect(type, url).toMatch(/^image\//);
        else if (original === "image/svg+xml") expect(type, `${url} is a 5.x SVG and is served as a download`).toBe("application/octet-stream");
        else expect(type.split(";")[0], url).toBe(original);
      }
    } finally {
      await kestrel.stop();
    }
  }, 60_000);

  it("names as site media leftovers only the 5.x export copies media.syncPublic left next to its own copies", async () => {
    const project = join(work, "project");
    mkdirSync(project);
    copyFileSync(join(PROJECT, "package.json"), join(project, "package.json"));
    symlinkSync(join(PROJECT, "node_modules"), join(project, "node_modules"), "dir");
    const modules = [
      { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: blobs } },
      { use: "@michaelthielemann/kestrel-persistence-sqlite", config: { file: db } },
      { use: "@michaelthielemann/kestrel-delivery-static", config: { types: { pages: {} }, prefix: "site/" } },
    ];
    writeFileSync(join(project, "kestrel.config.ts"), `export default ${JSON.stringify({ modules, triggers: [] })};\n`);
    const ids = new Set(Object.values(manifest.media).map((m) => m.id));
    expect(readdirSync(join(blobs, "site", "media")).filter((name) => ids.has(name)).length).toBeGreaterThan(0);
    const run = await cli(["data", "--root", project, "--db", db, "--json"]);
    expect(run.code, run.errors).toBe(0);
    const report = boundaryCast<UpgradeReport>(JSON.parse(run.out), "json");
    const leftovers = report.findings.filter((f) => f.rule === "data/site-media-leftovers");
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]?.message).toContain("4 entries");
    expect(leftovers[0]?.message).toContain("gallery/, logo.png, logo.png.small.webp, mark.svg");
    for (const id of ids) expect(leftovers[0]?.message).not.toContain(id);
  });

  it("never changes the fixture the copy was taken from, so the backup before the conversion stays in the 5.8.1 format", () => {
    expect(files(FIXTURE)).toEqual(fixtureBefore);
  });
});
