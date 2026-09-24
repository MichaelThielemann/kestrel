import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { runDataStep } from "./data.ts";

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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

});
