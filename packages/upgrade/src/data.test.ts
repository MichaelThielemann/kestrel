import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep } from "./data.ts";
import { runUpgradeCli } from "./plugin.ts";
import type { UpgradePlugin } from "./plugin.ts";
import type { UpgradeReport } from "./report.ts";

const createdCopyDirs: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const dir = await actual.mkdtemp(prefix);
      createdCopyDirs.push(dir);
      return dir;
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
      load: () => Promise.resolve({ issues: [] }),
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
      load: () => Promise.resolve({ issues: [] }),
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

  it("names the plugin, as a warning not an error, when a detected plugin has no dataModel hook and its own config cannot be loaded without it", async () => {
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
    expect(result.exitCode).toBe(0);
    const finding = result.report?.findings.find((f) => f.rule === "data/config-load-failed");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("warning");
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
      load: () => Promise.resolve({ issues: [] }),
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
  it("reports media_items rows whose key is off the <prefix><id>/<name> layout", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "media/" } }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string" });
    await db.createOne("media_items", { id: "m1", key: "media/m1/hero.jpg" });
    await db.createOne("media_items", { id: "m2", key: "off-layout-key" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const finding = result.report?.findings.find((f) => f.rule === "data/media-layout" && f.where.path === "media_items");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("m2");
    expect(finding?.message).toContain("off-layout-key");
  });

  it("does not fire when every media_items key is canonical", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-media-default", config: { prefix: "media/" } }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("media_items", { key: "string" });
    await db.createOne("media_items", { id: "m1", key: "media/m1/hero.jpg" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings.filter((f) => f.rule === "data/media-layout")).toEqual([]);
  });

  it("reports images_variants/images_retired rows with no slot, and stays quiet once every row has one", async () => {
    const root = await moduleProjectRoot([{ use: "@michaelthielemann/kestrel-images-default", config: {} }]);
    const file = join(dir, "kestrel.db");
    const db = createPersistenceSqlite({ file });
    await db.ensureCollection("images_variants", { slot: "string" });
    await db.ensureCollection("images_retired", { slot: "string" });
    await db.createOne("images_variants", { id: "v1", slot: null });
    await db.createOne("images_retired", { id: "r1", slot: "m1/thumb" });
    db.close();
    const result = await runDataStep(file, root);
    expect(result.exitCode).toBe(1);
    const variants = result.report?.findings.find((f) => f.rule === "data/media-layout" && f.where.path === "images_variants");
    const retired = result.report?.findings.find((f) => f.rule === "data/media-layout" && f.where.path === "images_retired");
    expect(variants?.message).toContain("1 row(s)");
    expect(retired).toBeUndefined();
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
      load: () => Promise.resolve({ issues: [] }),
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
      load: () => Promise.resolve({ issues: [] }),
      dataFindings: () => Promise.reject(new Error("broken hook")),
    };
    const result = await runDataStep(file, root, [plugin]);
    expect(result.report?.findings).toEqual([expect.objectContaining({ message: expect.stringContaining("broken hook") as unknown })]);
  });
});
