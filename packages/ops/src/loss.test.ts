import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "./harness.fixture.ts";
import { MemoryBucket, memoryStore } from "./memoryStore.ts";
import { lossReport } from "./sqlite.ts";

describe("loss report", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kestrel-ops-loss-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const database = (name: string, audit: Array<[string, number]>): string => {
    const file = join(dir, name);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE audit_entries ("id" TEXT PRIMARY KEY, "event" TEXT, "at" REAL)`);
    for (const [id, at] of audit) db.prepare(`INSERT INTO audit_entries VALUES (?, 'login', ?)`).run(id, at);
    db.close();
    return file;
  };

  it("counts the audit entries the backup does not hold, also ones written before its manifest", () => {
    const backup = database("backup.db", [["a1", 900]]);
    const current = database("current.db", [["a1", 900], ["a2", 1100], ["a3", 1400]]);
    const report = lossReport(current, backup, 1300);
    expect(report.auditEntriesAfter).toBe(2);
  });

  it("reports changes since the replica state the backup holds, not since its manifest", async () => {
    const h = createHarness({ store: memoryStore(new MemoryBucket("loss-since")) });
    try {
      await h.app.start();
      await h.app.seed();
      const backup = await h.run(["backup", "create", "--json"]);
      expect(backup.code).toBe(0);
      const source: unknown = Reflect.get(Object(backup.json.manifest), "source");
      h.app.run(`INSERT INTO pages VALUES ('later', 'Later', 'x')`);
      await h.app.sync();
      const restored = await h.run(["restore", "--backup", String(backup.json.id), "--yes", "--answers", h.answers({ "access-changes": "accept" }), "--json"]);
      expect(restored.code).toBe(0);
      expect(Reflect.get(Object(restored.json.loss), "since")).toBe(Reflect.get(Object(source), "lastFrameAt"));
    } finally {
      await h.dispose();
    }
  });
});
