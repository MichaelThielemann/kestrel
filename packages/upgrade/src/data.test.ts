import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDataStep } from "./data.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kestrel-upgrade-data-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeDb(file: string, rows: Array<{ id: string; name: string; pipeline: string | null; state: string }>): void {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE "events_queue" ("id" TEXT PRIMARY KEY, "name" TEXT, "pipeline" TEXT, "state" TEXT)`);
  const insert = db.prepare(`INSERT INTO "events_queue" ("id", "name", "pipeline", "state") VALUES (?, ?, ?, ?)`);
  for (const row of rows) insert.run(row.id, row.name, row.pipeline, row.state);
  db.close();
}

describe("runDataStep", () => {
  it("reports queue-unfanned rows grouped by event name and never mutates the original file", async () => {
    const file = join(dir, "kestrel.db");
    makeDb(file, [
      { id: "1", name: "page.created", pipeline: null, state: "pending" },
      { id: "2", name: "page.created", pipeline: null, state: "pending" },
      { id: "3", name: "media.uploaded", pipeline: "generateImageVariants", state: "done" },
    ]);
    const before = new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM events_queue").get();
    const result = await runDataStep(file);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toHaveLength(1);
    expect(result.report?.findings[0]).toMatchObject({ rule: "data/queue-unfanned", message: expect.stringContaining("2 stored event(s)") as unknown });
    const after = new DatabaseSync(file, { readOnly: true }).prepare("SELECT COUNT(*) AS n FROM events_queue").get();
    expect(after).toEqual(before);
  });

  it("finds nothing when every row is already fanned out", async () => {
    const file = join(dir, "kestrel.db");
    makeDb(file, [{ id: "1", name: "page.created", pipeline: "publishPage", state: "done" }]);
    const result = await runDataStep(file);
    expect(result.exitCode).toBe(0);
    expect(result.report?.findings).toEqual([]);
  });

  it("refuses a copy that is not a valid SQLite file, before reading anything", async () => {
    const file = join(dir, "not-a-db.db");
    await writeFile(file, "this is not sqlite");
    const result = await runDataStep(file);
    expect(result.exitCode).toBe(2);
    expect(result.error).toBeDefined();
  });

  it("refuses when the file does not exist", async () => {
    const result = await runDataStep(join(dir, "missing.db"));
    expect(result.exitCode).toBe(2);
  });
});
