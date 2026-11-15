import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep, storageFindings } from "./data.ts";
import { runUpgradeCli } from "./plugin.ts";
import type { LoadedProject, LoadResult, UpgradePlugin } from "./plugin.ts";
import type { Finding, UpgradeReport } from "./report.ts";

const createdCopyDirs: string[] = [];
const copiedFiles: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const dir = await actual.mkdtemp(prefix);
      createdCopyDirs.push(dir);
      return dir;
    },
    copyFile: async (from: string, to: string, mode?: number) => {
      copiedFiles.push(from);
      return actual.copyFile(from, to, mode);
    },
  };
});

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const QUEUE_SCHEMA = {
  name: "string",
  payload: "json",
  pipeline: "string",
  state: "string",
  attempts: "number",
  createdAt: "number",
  availableAt: "number",
  lockedAt: "number",
  lockedBy: "string",
  finishedAt: "number",
  error: "string",
  runId: "string",
} as const;

let dir: string;
const projectRoots: string[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const root of projectRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function contentProjectRoot(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-test-"));
  projectRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  await writeFile(join(root, "kestrel.config.ts"), `export default { modules: [{ use: "@michaelthielemann/kestrel-content-default", config: ${JSON.stringify(config)} }], triggers: [] };\n`);
  return root;
}

async function storageFindingFor(file: string, root: string): Promise<Finding | undefined> {
  const db = createPersistenceSqlite({ file });
  try {
    return (await storageFindings(root, file, db)).find((f) => f.rule === "data/media-layout");
  } finally {
    db.close();
  }
}

async function moduleProjectRoot(modules: Array<{ use: string; config?: unknown }>): Promise<string> {
  const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-media-test-"));
  projectRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  const modulesText = modules.map((m) => `{ use: "${m.use}", config: ${JSON.stringify(m.config ?? {})} }`).join(", ");
  await writeFile(join(root, "kestrel.config.ts"), `export default { modules: [${modulesText}], triggers: [] };\n`);
  return root;
}

async function pluginProjectRoot(): Promise<string> {
  const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-plugin-test-"));
  projectRoots.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
  return root;
}

function emptyProject(root: string): LoadResult {
  const project = { kind: "test-plugin", configFile: join(root, "kestrel.config.ts"), moduleFiles: new Map(), pipelineFiles: [], input: { config: { modules: [], triggers: [] }, modules: [], pipelines: [], root } };
  return { project: boundaryCast<LoadedProject>(project, "host"), issues: [] };
}

async function makeDb(file: string, rows: Array<{ id: string; name: string; pipeline: string | null; state: string }>): Promise<void> {
  const db = createPersistenceSqlite({ file });
  await db.ensureCollection("events_queue", QUEUE_SCHEMA);
  for (const row of rows) {
    await db.createOne("events_queue", { id: row.id, name: row.name, pipeline: row.pipeline, state: row.state, payload: {}, attempts: 0, createdAt: 0, availableAt: 0, lockedAt: null, lockedBy: null, finishedAt: null, error: null, runId: null });
  }
  db.close();
}

describe("runDataStep", () => {
  it("reports queue-unfanned rows grouped by event name and never mutates the original file", async () => {
    const file = join(dir, "kestrel.db");
    await makeDb(file, [
      { id: "1", name: "page.created", pipeline: null, state: "pending" },
      { id: "2", name: "page.created", pipeline: null, state: "pending" },
      { id: "3", name: "media.uploaded", pipeline: "generateImageVariants", state: "done" },
    ]);
    const before = new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM events_queue").get();
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toHaveLength(1);
    expect(result.report?.findings[0]).toMatchObject({ rule: "data/queue-unfanned", message: expect.stringContaining("2 stored event(s)") as unknown });
    const after = new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM events_queue").get();
    expect(after).toEqual(before);
  });

  it("reports dead-letter rows with no pipeline assigned", async () => {
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: null, state: "dead" }]);
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/queue-dead-unassigned" })]);
  });

  it("finds nothing when every row is already fanned out", async () => {
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toEqual([]);
  });

  it("refuses a copy that is not a valid SQLite file, before reading anything", async () => {
    const file = join(dir, "not-a-db.db");
    await writeFile(file, "this is not sqlite");
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(2);
    expect(result.error).toBeDefined();
  });

  it("refuses when the file does not exist", async () => {
    const result = await runDataStep(join(dir, "missing.db"), PROJECT_ROOT);
    expect(result.exitCode).toBe(2);
  });

  it("runs past a lock file another process left next to the database and never copies it", async () => {
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const lock = JSON.stringify({ host: "another-host", pid: 4242, startedAt: Date.now(), heartbeatAt: Date.now(), ttlMs: 60_000 });
    await writeFile(`${file}.instance`, lock);
    copiedFiles.length = 0;
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toEqual([]);
    expect(copiedFiles).toContain(file);
    expect(copiedFiles.filter((f) => f.endsWith(".instance"))).toEqual([]);
    expect(readFileSync(`${file}.instance`, "utf8")).toBe(lock);
  });

  it("removes its own copy directory afterward, on success and on refusal", async () => {
    createdCopyDirs.length = 0;
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: null, state: "pending" }]);
    await runDataStep(file, PROJECT_ROOT);
    const badFile = join(dir, "not-a-db.db");
    await writeFile(badFile, "this is not sqlite");
    await runDataStep(badFile, PROJECT_ROOT);
    expect(createdCopyDirs.length).toBeGreaterThan(0);
    for (const copyDir of createdCopyDirs) expect(existsSync(copyDir)).toBe(false);
  });
});

describe("runDataStep: underscore-field counts", () => {
  it("counts zero for a field with no stored values", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 0 } });
    expect(result.report?.findings).toEqual([]);
  });

  it("counts a field the content model declares only in host-supplied defaults", async () => {
    const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-test-"));
    projectRoots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
    const defaults = { from: "site-preset", values: { types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } } };
    await writeFile(join(root, "kestrel.config.ts"), `export default { modules: [{ use: "@michaelthielemann/kestrel-content-default", config: {}, defaults: ${JSON.stringify(defaults)} }], triggers: [] };\n`);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
  });

  it("counts a stored value for an unlocalized field and reports it as a finding", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    await db.createOne("page", { id: "2", _hint: null });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/underscore-field-stored", message: expect.stringContaining("1 stored value(s)") as unknown })]);
  });

  it("counts per locale column for a localized field", async () => {
    const root = await contentProjectRoot({ locales: ["de", "en"], types: { page: { kind: "multi", fields: { _hint: { type: "string", localized: true } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint__de: "string", _hint__en: "string" });
    await db.createOne("page", { id: "1", _hint__de: "wert", _hint__en: null });
    await db.createOne("page", { id: "2", _hint__de: null, _hint__en: "value" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { de: 1, en: 1 } });
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/underscore-field-stored", message: expect.stringMatching(/1 in "de".*1 in "en"/) as unknown })]);
  });

  it("finds nothing to count when the project has no content-default module", async () => {
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({});
  });

  it("reports null, never zero, when the type's table does not exist at all", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    createPersistenceSqlite({ file }).close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: null } });
  });

  it("reports null, never zero, when the column does not exist on an existing table", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { title: "string" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: null } });
  });

  it("reports null, never zero, when the count itself fails", async () => {
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { title: "string" });
    db.close();
    const raw = new DatabaseSync(file);
    raw.exec('ALTER TABLE "page" ADD COLUMN "_hint with a space" TEXT');
    raw.close();
    const badRoot = await contentProjectRoot({ types: { page: { kind: "multi", fields: { "_hint with a space": { type: "string" } } } } });
    const result = await runDataStep(file, badRoot);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint with a space": { unlocalized: null } });
  });

  it("stays silent about a regular field with no orphaned underscore column", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { hint: "string" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({});
    expect(result.report?.findings).toEqual([]);
  });

  it("still counts an orphaned underscore column left behind by a rename already applied to the config", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { hint: "string", _hint: "string" });
    await db.createOne("page", { id: "1", hint: "new value", _hint: "orphaned legacy value" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/underscore-field-stored", where: { path: "page._hint" } })]);
  });
});

describe("runDataStep: underscore-field counts for a plugin project", () => {
  it("counts stored values using a plugin's dataModel hook, without a content-default module", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    db.close();
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve(emptyProject(root)),
      dataModel: () => Promise.resolve({ types: { page: { fields: { _hint: {} } } } }),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/underscore-field-stored" })]);
  });

  it("skips underscore-field counting when the plugin's dataModel hook returns undefined", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve(emptyProject(root)),
      dataModel: () => Promise.resolve(undefined),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({});
  });

  it("reports a plugin/hook-failed error, instead of silently skipping the count, when dataModel() throws", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve({ issues: [] }),
      dataModel: () => {
        throw new Error("boom");
      },
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "plugin/hook-failed");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("test-plugin");
    expect(finding?.message).toContain("dataModel");
    expect(result.report?.underscoreFields).toEqual({});
  });

  it("falls back to the built-in content-default search when the active plugin declares no dataModel hook", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    db.close();
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve({ issues: [] }),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(0);
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
  });

  it("reports a plugin's detect() throwing, instead of silently skipping it, and still falls back to the built-in data model", async () => {
    const root = await contentProjectRoot({ types: { page: { kind: "multi", fields: { _hint: { type: "string" } } } } });
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    db.close();
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: () => {
        throw new Error("detect boom");
      },
      load: () => Promise.resolve({ issues: [] }),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "load/failed");
    expect(finding).toBeDefined();
    expect(finding?.message).toContain("test-plugin");
    expect(finding?.message).toContain("detect() threw");
    expect(result.report?.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
  });

  it("reports a data/config-load-failed error, instead of silently skipping the count, when kestrel.config.ts cannot be loaded", async () => {
    const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-broken-config-test-"));
    projectRoots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
    await writeFile(join(root, "kestrel.config.ts"), "this is not valid TypeScript {{{\n");
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "data/config-load-failed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("kestrel.config.ts");
    expect(result.report?.underscoreFields).toEqual({});
  });

  it("names the plugin, as an error, when a detected plugin has no dataModel hook and its own config cannot be loaded without it", async () => {
    const root = await mkdtemp(join(PROJECT_ROOT, "__fixtures__", ".tmp-data-plugin-broken-config-test-"));
    projectRoots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module" }));
    await writeFile(join(root, "kestrel.config.ts"), "export default presetModuleConfig({ persistenceFile: './data/kestrel.db' });\n");
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const plugin: UpgradePlugin = {
      kind: "test-host-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve({ issues: [] }),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "data/config-load-failed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("test-host-plugin");
    expect(finding?.message).toContain("no dataModel hook");
    expect(result.report?.underscoreFields).toEqual({});
  });
});

describe("the data CLI command with a registered plugin", () => {
  it("passes registered plugins through to runDataStep, so a plugin's dataModel hook is consulted", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { _hint: "string" });
    await db.createOne("page", { id: "1", _hint: "legacy value" });
    db.close();
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve(emptyProject(root)),
      dataModel: () => Promise.resolve({ types: { page: { fields: { _hint: {} } } } }),
    };
    const lines: string[] = [];
    const code = await runUpgradeCli(["data", "--root", root, "--db", file, "--json"], { stdout: (l) => lines.push(l), stderr: () => undefined, plugins: [plugin] });
    expect(code).toBe(0);
    const report = boundaryCast<UpgradeReport>(JSON.parse(lines.join("\n")), "json");
    expect(report.underscoreFields).toEqual({ "page._hint": { unlocalized: 1 } });
  });
});

describe("runDataStep: data/media-layout", () => {
  it("reports media stored in the 5.x key layout through media-default's own detector, naming the migration and the command", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "media/" } }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string", folder: "string", filename: "string", contentType: "string", size: "number", status: "string" });
    await db.createOne("media_items", { id: "m2", key: "media/gallery/hero.jpg", folder: "gallery", filename: "hero.jpg", contentType: "image/jpeg", size: 3, status: "ready" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "data/media-layout");
    expect(finding).toMatchObject({ id: "data/media-layout:media/default", severity: "error", where: { module: "media/default" } });
    expect(finding?.message).toContain("media-default:id-key-layout");
    expect(finding?.message).toContain("m2");
    expect(finding?.message).toContain("kestrel upgrade migrate --db <file> --blobs-dir <dir>");
    expect(finding?.message).not.toContain("empty");
  });

  it("does not fire on media in the 6.0.0 layout", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "media/" } }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string", folder: "string", filename: "string", location: "string", contentType: "string", size: "number", status: "string" });
    await db.createOne("media_items", { id: "m1", key: "media/m1/hero.jpg", folder: "", filename: "hero.jpg", location: "hero.jpg", contentType: "image/jpeg", size: 3, status: "ready" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.report?.findings.filter((f) => f.rule === "data/media-layout")).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("reports images_variants rows with no slot through images-default's detector, and stays quiet once every row has one", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-images-default", config: {} }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("images_variants", { mediaId: "string", size: "string", slot: "string", state: "string" });
    await db.ensureCollection("images_retired", { mediaId: "string", file: "string", slot: "string" });
    await db.createOne("images_variants", { id: "v1", mediaId: "m1", size: "thumb", slot: null, state: "done" });
    await db.createOne("images_retired", { id: "r1", mediaId: "m1", file: "thumb.png", slot: "m1/thumb" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "data/media-layout");
    expect(finding).toMatchObject({ id: "data/media-layout:images/default", severity: "error" });
    expect(finding?.message).toContain("images-default:variant-slots (introduced in 6.0.0; 1 item(s)");

    const slotted = createPersistenceSqlite({ file });
    await slotted.ensureCollection("images_variants", { slot: "string" });
    await slotted.updateOne("images_variants", "v1", { slot: "m1/thumb" });
    slotted.close();
    const clean = await runDataStep(file, root);
    expect(clean.report?.findings.filter((f) => f.rule === "data/media-layout")).toEqual([]);
  });

  it("warns that the storage shape was checked with the defaults when kestrel.config.ts does not load, and takes the config from the host plugin otherwise", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "files/" } }]);
    await writeFile(join(root, "kestrel.config.ts"), `throw new Error("a setting the config reads is not set");\n`);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string", folder: "string", filename: "string", location: "string", contentType: "string", size: "number", status: "string" });
    await db.createOne("media_items", { id: "m1", key: "files/m1/hero.jpg", folder: "", filename: "hero.jpg", location: "hero.jpg", contentType: "image/jpeg", size: 3, status: "ready" });
    db.close();
    const host = (prefix: string): UpgradePlugin => ({
      kind: "test-host",
      detect: () => true,
      dataModel: () => Promise.resolve(undefined),
      load: () => Promise.resolve({ project: boundaryCast<LoadedProject>({ kind: "test-host", configFile: "kestrel.config.ts", moduleFiles: new Map(), pipelineFiles: [], input: { config: { modules: [{ use: "@michaelthielemann/kestrel-media-default", config: { prefix } }], triggers: [] }, modules: [], pipelines: [] } }, "host"), issues: [] }),
    });
    const unloaded = await runDataStep(file, root, [{ ...host("files/"), load: () => Promise.resolve({ issues: [{ message: "the host could not read its config either" }] }) }]);
    const warning = unloaded.report?.findings.find((f) => f.id === "data/media-layout:config");
    expect(warning).toMatchObject({ severity: "warning" });
    expect(warning?.message).toContain("a setting the config reads is not set");
    expect(warning?.message).toContain("the host could not read its config either");

    const fromPlugin = await runDataStep(file, root, [host("files/")]);
    expect(fromPlugin.report?.findings.filter((f) => f.rule === "data/media-layout")).toEqual([]);
    const otherPrefix = await runDataStep(file, root, [host("media/")]);
    expect(otherPrefix.report?.findings.find((f) => f.rule === "data/media-layout")).toMatchObject({ id: "data/media-layout:media/default", severity: "error" });
  });

  it("warns instead of guessing when the installed module has no storage export", async () => {
    const root = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-bare-"));
    projectRoots.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "tmp", type: "module", dependencies: { "@michaelthielemann/kestrel-media-default": "5.8.1" } }));
    const installed = join(root, "node_modules", "@michaelthielemann", "kestrel-media-default");
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name: "@michaelthielemann/kestrel-media-default", version: "5.8.1", type: "module", exports: { ".": "./index.js", "./impl": "./impl.js" } }));
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string" });
    await db.createOne("media_items", { id: "m2", key: "media/gallery/hero.jpg" });
    db.close();
    const finding = await storageFindingFor(file, root);
    expect(finding).toMatchObject({ id: "data/media-layout:@michaelthielemann/kestrel-media-default", severity: "warning" });
    expect(finding?.message).toContain("media_items");
    expect(finding?.suggestion).toContain("install the 6.0.0 packages");
  });
});

describe("runDataStep: data/site-media-leftovers and data/blobstore-tmp-suffix", () => {
  it("lists entries under the 5.x delivery-static media export directory", async () => {
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } },
      { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
    ]);
    const leftoverDir = join(root, "blobs", "site", "media");
    await mkdir(leftoverDir, { recursive: true });
    await writeFile(join(leftoverDir, "orphan.jpg"), "x");
    const file = join(dir, "kestrel.db");
    createPersistenceSqlite({ file }).close();
    const result = await runDataStep(file, root);
    const finding = result.report?.findings.find((f) => f.rule === "data/site-media-leftovers");
    expect(finding).toBeDefined();
    expect(finding?.fix.kind).toBe("manual");
    expect(finding?.message).toContain("1 entry");
  });

  it("names only the entries that are not the public copy of a stored media item", async () => {
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } },
      { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
    ]);
    const leftoverDir = join(root, "blobs", "site", "media");
    await mkdir(join(leftoverDir, "m1"), { recursive: true });
    await writeFile(join(leftoverDir, "m1", "hero.jpg"), "x");
    await mkdir(join(leftoverDir, "gallery"), { recursive: true });
    await writeFile(join(leftoverDir, "gallery", "hero.jpg"), "x");
    await writeFile(join(leftoverDir, "logo.png"), "x");
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string" });
    await db.createOne("media_items", { id: "m1", key: "media/m1/hero.jpg" });
    db.close();
    const result = await runDataStep(file, root);
    const finding = result.report?.findings.find((f) => f.rule === "data/site-media-leftovers");
    expect(finding?.message).toContain("2 entries");
    expect(finding?.message).toContain("gallery/, logo.png");
    expect(finding?.message).not.toContain("m1");
    expect(finding?.suggestion).toContain("delete what is left of these entries");
    expect(finding?.suggestion).toContain("removes the files exactly one folder deep");
    expect(finding?.suggestion).not.toContain("leaves these entries in place");
    expect(finding?.suggestion).not.toContain("never touches");
    expect(finding?.suggestion).not.toContain("delete the directory");
  });

  it("does not fire when the export directory holds only the public copies of stored media items", async () => {
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } },
      { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
    ]);
    const leftoverDir = join(root, "blobs", "site", "media");
    await mkdir(join(leftoverDir, "m1", "variants"), { recursive: true });
    await writeFile(join(leftoverDir, "m1", "hero.jpg"), "x");
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string" });
    await db.createOne("media_items", { id: "m1", key: "media/m1/hero.jpg" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.report?.findings.filter((f) => f.rule === "data/site-media-leftovers")).toEqual([]);
  });

  it("does not fire when the export directory is empty or missing", async () => {
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } },
      { use: "@michaelthielemann/kestrel-delivery-static", config: { prefix: "site/", media: { target: "media/" } } },
    ]);
    const file = join(dir, "kestrel.db");
    createPersistenceSqlite({ file }).close();
    const result = await runDataStep(file, root);
    expect(result.report?.findings.filter((f) => f.rule === "data/site-media-leftovers")).toEqual([]);
  });

  it("reports stored keys already ending in .kestrel-tmp", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-blobstore-filesystem", config: { root: "./blobs" } }]);
    const blobDir = join(root, "blobs", "media", "m1");
    await mkdir(blobDir, { recursive: true });
    await writeFile(join(blobDir, "hero.jpg.kestrel-tmp"), "x");
    const file = join(dir, "kestrel.db");
    createPersistenceSqlite({ file }).close();
    const result = await runDataStep(file, root);
    const finding = result.report?.findings.find((f) => f.rule === "data/blobstore-tmp-suffix");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("info");
    expect(finding?.message).toContain("hero.jpg.kestrel-tmp");
  });

  it("does not fire without a blobstore-filesystem module configured", async () => {
    const root = await moduleProjectRoot([]);
    const file = join(dir, "kestrel.db");
    createPersistenceSqlite({ file }).close();
    const result = await runDataStep(file, root);
    expect(result.report?.findings.filter((f) => f.rule === "data/blobstore-tmp-suffix" || f.rule === "data/site-media-leftovers")).toEqual([]);
  });
});

describe("runDataStep: findings a plugin reads from stored data", () => {
  it("adds what the plugin's dataFindings hook reports from the verified copy", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("page", { note: "string" });
    await db.createOne("page", { id: "1", note: "stored" });
    db.close();
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve(emptyProject(root)),
      dataModel: () => Promise.resolve({ types: { page: { fields: { note: {} } } } }),
      async dataFindings(copy, projectRoot, model) {
        await copy.ensureCollection("page", { note: "string" });
        const rows = await copy.findMany<{ id: string; note: string }>("page", {});
        const count = rows.ok ? rows.value.items.length : -1;
        return [{ id: "plugin-data-1", rule: "data/plugin-stored", severity: "error", tier: "data", where: { path: projectRoot }, message: `${count} row(s) of ${Object.keys(model?.types ?? {}).join(",")}`, suggestion: "", fix: { kind: "manual" }, docs: "" }];
      },
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.exitCode).toBe(1);
    expect(result.report?.findings).toEqual([expect.objectContaining({ rule: "data/plugin-stored", message: "1 row(s) of page", where: { path: root } })]);
  });

  it("reports a throwing dataFindings hook as a finding instead of failing the step", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    await makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve(emptyProject(root)),
      dataFindings: () => Promise.reject(new Error("broken hook")),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.report?.findings).toEqual([expect.objectContaining({ message: expect.stringContaining("broken hook") as unknown })]);
  });
});

describe("runDataStep: translations published without a slug of their own", () => {
  const contentConfig = {
    locales: ["de", "en"],
    defaultLocale: "de",
    types: {
      pages: {
        kind: "multi",
        fields: { slug: { type: "slug", required: true, localized: true }, title: { type: "text", required: true, localized: true }, status: { type: "enum", options: ["draft", "published"], localized: true } },
      },
    },
  };
  const siteConfig = { routes: { pages: { home: "home", liveWhen: { status: "published" } } } };

  async function pagesDb(file: string, rows: Array<Record<string, unknown>>): Promise<void> {
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("pages", { slug__de: "string", slug__en: "string", title__de: "string", title__en: "string", status__de: "string", status__en: "string" });
    for (const row of rows) await db.createOne("pages", row);
    db.close();
  }

  it("reports each one, and names the slug to copy only where the default locale is published", async () => {
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-content-default", config: contentConfig },
      { use: "@michaelthielemann/kestrel-site-default", config: siteConfig },
    ]);
    const file = join(dir, "kestrel.db");
    await pagesDb(file, [
      { id: "open", slug__de: "sommerfest", title__de: "Sommerfest", status__de: "published", title__en: "Summer party", status__en: "published" },
      { id: "hidden", slug__de: "geheimer-plan", title__de: "Plan", status__de: "draft", title__en: "Press release", status__en: "published" },
      { id: "fine", slug__de: "kontakt", title__de: "Kontakt", status__de: "published", slug__en: "contact", title__en: "Contact", status__en: "published" },
      { id: "draft", slug__de: "neu", title__de: "Neu", status__de: "published", title__en: "New", status__en: "draft" },
      { id: "untranslated", slug__de: "nur-de", title__de: "Nur DE", status__de: "published" },
    ]);
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const findings = result.report?.findings.filter((f) => f.rule === "data/translation-slug") ?? [];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", tier: "data", where: { path: "pages" }, fix: { kind: "manual" } });
    expect(findings[0]?.message).toContain("open (en)");
    expect(findings[0]?.message).toContain("hidden (en)");
    expect(findings[0]?.message).not.toContain("fine");
    expect(findings[0]?.message).not.toContain("draft (en)");
    expect(findings[0]?.message).not.toContain("untranslated");
    expect(findings[0]?.suggestion).toContain('open (en): "sommerfest"');
    expect(findings[0]?.suggestion).not.toContain("geheimer-plan");
  });

  it("reports a document published below a page without a slug in its locale, and a mounted one under such a page", async () => {
    const nested = {
      ...contentConfig,
      types: {
        pages: { kind: "multi", fields: { ...contentConfig.types.pages.fields, parent: { type: "ref", to: "pages" } } },
        posts: contentConfig.types.pages,
        settings: { kind: "single", fields: { mounts: { type: "json" } } },
      },
    };
    const root = await moduleProjectRoot([
      { use: "@michaelthielemann/kestrel-content-default", config: nested },
      { use: "@michaelthielemann/kestrel-site-default", config: { routes: { pages: { home: "home", liveWhen: { status: "published" }, parentField: "parent" }, posts: { liveWhen: { status: "published" }, mount: true } }, mounts: { type: "settings", field: "mounts" } } },
    ]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    const columns = { slug__de: "string", slug__en: "string", title__de: "string", title__en: "string", status__de: "string", status__en: "string" } as const;
    await db.ensureCollection("pages", { ...columns, parent: "string" });
    await db.ensureCollection("posts", columns);
    await db.ensureCollection("settings", { mounts: "json" });
    await db.createOne("pages", { id: "geheim", slug__de: "geheim", title__de: "Geheim", status__de: "draft", parent: null });
    await db.createOne("pages", { id: "kind", slug__de: "kind", title__de: "Kind", status__de: "published", slug__en: "kid", title__en: "Kid", status__en: "published", parent: "geheim" });
    await db.createOne("pages", { id: "blog", slug__de: "blog", title__de: "Blog", status__de: "published", parent: null });
    await db.createOne("posts", { id: "hallo", slug__de: "hallo", title__de: "Hallo", status__de: "published", slug__en: "hello", title__en: "Hello", status__en: "published" });
    await db.createOne("settings", { id: "settings", mounts: { posts: "blog" } });
    db.close();
    const result = await runDataStep(file, root);
    const below = result.report?.findings.filter((f) => f.id.endsWith(":below")) ?? [];
    expect(below.map((f) => f.where.path)).toEqual(["pages", "posts"]);
    expect(below[0]?.message).toContain("kind (en) below pages/geheim");
    expect(below[1]?.message).toContain("hallo (en) below pages/blog");
    expect(result.report?.findings.some((f) => f.message.includes("kind (de)"))).toBe(false);
  });

  it("reports nothing without a routed type", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-content-default", config: contentConfig }]);
    const file = join(dir, "kestrel.db");
    await pagesDb(file, [{ id: "open", slug__de: "sommerfest", title__de: "Sommerfest", status__de: "published", title__en: "Summer party", status__en: "published" }]);
    const result = await runDataStep(file, root);
    expect(result.report?.findings.filter((f) => f.rule === "data/translation-slug")).toEqual([]);
  });

  it("reads the routes a plugin's dataModel hook supplies", async () => {
    const root = await pluginProjectRoot();
    const file = join(dir, "kestrel.db");
    await pagesDb(file, [{ id: "open", slug__de: "sommerfest", title__de: "Sommerfest", status__de: "published", title__en: "Summer party", status__en: "published" }]);
    const plugin: UpgradePlugin = {
      kind: "test-plugin",
      detect: (candidate) => candidate === root,
      load: () => Promise.resolve({ issues: [] }),
      dataModel: () => Promise.resolve({ locales: ["de", "en"], defaultLocale: "de", types: { pages: { fields: { slug: { localized: true }, title: { localized: true }, status: { localized: true } } } }, routes: { pages: { liveWhen: { status: "published" } } } }),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.report?.findings.map((f) => f.rule)).toContain("data/translation-slug");
  });
});
