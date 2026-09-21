import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistenceSqlite } from "@michaelthielemann/kestrel-persistence-sqlite/impl";
import { isErr } from "@michaelthielemann/kestrel/result";

const LEGACY_SCHEMA = {
  name: "string",
  payload: "json",
  state: "string",
  attempts: "number",
  createdAt: "number",
  availableAt: "number",
  lockedAt: "number",
  lockedBy: "string",
  finishedAt: "number",
  error: "string",
} as const;

export interface LegacyRow {
  name: string;
  payload: Record<string, unknown>;
  state: "pending" | "running" | "dead" | "done";
  attempts: number;
  createdAt: number;
  availableAt: number;
  lockedAt: number | null;
  lockedBy: string | null;
  finishedAt: number | null;
  error: string | null;
}

export function legacyQueueFile(): string {
  return join(mkdtempSync(join(tmpdir(), "kestrel-events-queue-")), "queue.db");
}

/** Creates a SQLite file with the 5.x `events_queue` column set (no `pipeline`) and inserts the given rows. */
export async function seedLegacyQueue(file: string, rows: readonly LegacyRow[]): Promise<void> {
  const db = createPersistenceSqlite({ file });
  const ensured = await db.ensureCollection("events_queue", LEGACY_SCHEMA);
  if (isErr(ensured)) throw new Error(`legacyQueue: cannot create the 5.x collection: ${ensured.error.message}`);
  for (const row of rows) {
    const created = await db.createOne("events_queue", { ...row });
    if (isErr(created)) throw new Error(`legacyQueue: cannot insert a 5.x row: ${created.error.message}`);
  }
  db.close();
}
