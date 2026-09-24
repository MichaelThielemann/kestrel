import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDataStep } from "./data.ts";

const PROJECT_ROOT = join(import.meta.dirname, "..");

function fakePersistence(overrides: { ensureCollection?: () => Promise<unknown>; findMany?: () => Promise<unknown> }) {
  return {
    createPersistenceSqlite: () => ({
      ensureCollection: overrides.ensureCollection ?? (async () => ({ ok: true, value: undefined })),
      findMany: overrides.findMany ?? (async () => ({ ok: true, value: { items: [], total: 0 } })),
      close: () => undefined,
    }),
  };
}

const TRANSIENT_ERROR = { ok: false, error: { code: "TRANSIENT", status: 503, message: "disk I/O error", retryable: true } };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-error-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.doUnmock("@michaelthielemann/kestrel-persistence-sqlite/impl");
  vi.resetModules();
});

async function makeValidDbFile(): Promise<string> {
  const file = join(dir, "kestrel.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE placeholder (id TEXT)");
  db.close();
  return file;
}

describe("runDataStep refuses instead of reporting zero findings on a real read failure", () => {
  it("refuses (exit 2) when ensureCollection cannot read the collection", async () => {
    vi.doMock("@michaelthielemann/kestrel-persistence-sqlite/impl", () => fakePersistence({ ensureCollection: async () => TRANSIENT_ERROR }));
    vi.resetModules();
    const { runDataStep: freshRunDataStep } = await import("./data.ts");
    const file = await makeValidDbFile();
    const result = await freshRunDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("disk I/O error");
    expect(result.report).toBeUndefined();
  });

  it("refuses (exit 2) when findMany cannot read the queue rows", async () => {
    vi.doMock("@michaelthielemann/kestrel-persistence-sqlite/impl", () => fakePersistence({ findMany: async () => TRANSIENT_ERROR }));
    vi.resetModules();
    const { runDataStep: freshRunDataStep } = await import("./data.ts");
    const file = await makeValidDbFile();
    const result = await freshRunDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain("disk I/O error");
    expect(result.report).toBeUndefined();
  });
});

describe("runDataStep still works normally without a mocked persistence module", () => {
  it("sanity: a project with no findings still exits 0", async () => {
    const file = await makeValidDbFile();
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toEqual([]);
  });

  it("still refuses a file that fails PRAGMA quick_check, unrelated to persistence errors", async () => {
    const file = join(dir, "not-a-db.db");
    await writeFile(file, "not sqlite");
    const result = await runDataStep(file, PROJECT_ROOT);
    expect(result.exitCode).toBe(2);
  });
});
