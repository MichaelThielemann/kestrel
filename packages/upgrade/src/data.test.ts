import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
