import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { createEventsQueue, QUEUE, type QueueRow } from "./impl.ts";
import { legacyQueueFile, seedLegacyQueue } from "./__fixtures__/legacyQueue.ts";

describe("events/queue upgrade from a 5.x queue table", () => {
  let file: string | undefined;

  afterEach(() => {
    if (file) rmSync(file, { force: true });
    file = undefined;
  });

  it("fans out rows pending at upgrade to every currently subscribed pipeline, at the first tick", async () => {
    file = legacyQueueFile();
    const now = Date.now();
    await seedLegacyQueue(file, [
      { name: "user.deleted", payload: { id: "u1" }, state: "pending", attempts: 0, createdAt: now, availableAt: now, lockedAt: null, lockedBy: null, finishedAt: null, error: null },
      { name: "user.deleted", payload: { id: "u2" }, state: "running", attempts: 0, createdAt: now, availableAt: now, lockedAt: now - 999_999, lockedBy: "old@host", finishedAt: null, error: null },
      { name: "user.deleted", payload: { id: "u3" }, state: "dead", attempts: 5, createdAt: now, availableAt: now, lockedAt: null, lockedBy: null, finishedAt: now, error: "boom" },
      { name: "nobody.subscribes", payload: {}, state: "pending", attempts: 0, createdAt: now, availableAt: now, lockedAt: null, lockedBy: null, finishedAt: null, error: null },
    ]);

    const db = createPersistenceSqlite({ file });
    const queue = await createEventsQueue({ pollMs: 500, batch: 20, maxAttempts: 3, backoffSeconds: [5], lockTtlSeconds: 60, retentionDays: 7, relayMs: 5000, relayPipelines: "all", lanes: {} }, { db, logger: silentLogger });
    const delivered: string[] = [];
    queue.setDelivery(
      [
        { event: "user.deleted", pipeline: "anonymizeAuditUser" },
        { event: "user.deleted", pipeline: "reassignRevisionAuthor" },
      ],
      async (pipeline) => {
        delivered.push(pipeline);
        return { runId: "r", status: 200 };
      },
    );

    expect(await queue.tick()).toBe(4);
    expect(delivered.sort()).toEqual(["anonymizeAuditUser", "anonymizeAuditUser", "reassignRevisionAuthor", "reassignRevisionAuthor"]);

    const rows = await db.findMany<QueueRow>(QUEUE, {}, { sort: { createdAt: "asc" } });
    if (!rows.ok) throw new Error("expected findMany to succeed");
    const stillNull = rows.value.items.filter((r) => r.pipeline === null);
    const fanned = rows.value.items.filter((r) => r.pipeline !== null);
    expect(stillNull).toMatchObject([{ name: "user.deleted", state: "dead" }]);
    expect(fanned).toHaveLength(4);
    expect(fanned.every((r) => r.state === "done")).toBe(true);
    expect(fanned.filter((r) => r.name === "nobody.subscribes")).toHaveLength(0);

    db.close();
  });
});
