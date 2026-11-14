import { appendFileSync } from "node:fs";
import { keys, parseJson } from "./layout.ts";
import type { Redactor } from "./redact.ts";
import type { ObjectStore } from "./store.ts";

/** One journal entry: a step's transition with its inputs and outputs (ids and hashes, never secrets). */
export interface JournalEntry {
  runId: string;
  seq: number;
  step: string;
  state: "started" | "done" | "failed" | "skipped";
  at: number;
  data: Record<string, unknown>;
}

const TERMINAL = new Set(["run-done", "run-failed"]);

/**
 * A run's journal in the backup location, one write-once object per transition, mirrored into a local file.
 * Everything written passes the redactor. `startSeq` continues the journal of a run another process began: the first
 * entry gets `startSeq + 1`, so no key of that run is written twice.
 */
export class Journal {
  #seq: number;

  constructor(
    readonly runId: string,
    private readonly store: ObjectStore,
    private readonly location: string,
    private readonly redactor: Redactor,
    private readonly clock: () => number,
    private readonly mirror: string | null,
    startSeq = 0,
  ) {
    this.#seq = startSeq;
  }

  async record(step: string, state: JournalEntry["state"], data: Record<string, unknown> = {}): Promise<void> {
    this.#seq += 1;
    const entry: JournalEntry = { runId: this.runId, seq: this.#seq, step, state, at: this.clock(), data };
    const text = this.redactor.json(entry, 2);
    await this.store.put(this.location + keys.journal(this.runId, this.#seq, step, state), new TextEncoder().encode(text + "\n"), { contentType: "application/json" });
    if (this.mirror !== null) appendFileSync(this.mirror, this.redactor.json(entry) + "\n", { mode: 0o600 });
  }

  /** Ends the run; a run without this entry counts as open. */
  async finish(ok: boolean, data: Record<string, unknown> = {}): Promise<void> {
    await this.record(ok ? "run-done" : "run-failed", ok ? "done" : "failed", data);
  }
}

/** A run as its journal shows it. */
export interface RunSummary {
  runId: string;
  command: string;
  startedAt: number;
  lastAt: number;
  finished: boolean;
  /** Backup ids the run pinned or wrote. */
  backups: string[];
}

/** How long a run without a new journal entry still counts as open. */
export const RUN_STALE_MS = 2 * 60 * 60 * 1000;

/** Every run in the journal of the backup location. */
export async function listRuns(store: ObjectStore, location: string): Promise<RunSummary[]> {
  const byRun = new Map<string, RunSummary>();
  for (const info of await store.list(`${location}runs/`)) {
    const m = /^runs\/([^/]+)\/(\d{6})-(.+)-(started|done|failed|skipped)\.json$/.exec(info.key.slice(location.length));
    if (!m) continue;
    const runId = m[1] ?? "";
    const step = m[3] ?? "";
    let run = byRun.get(runId);
    if (!run) {
      run = { runId, command: "", startedAt: info.lastModified, lastAt: info.lastModified, finished: false, backups: [] };
      byRun.set(runId, run);
    }
    run.lastAt = Math.max(run.lastAt, info.lastModified);
    run.startedAt = Math.min(run.startedAt, info.lastModified);
    if (TERMINAL.has(step)) run.finished = true;
    if (step === "run" || /-backup$/.test(step) || step === "backup") {
      const data = await store.get(info.key);
      const entry: unknown = data === null ? null : parseJson(data);
      const payload: unknown = typeof entry === "object" && entry !== null ? Reflect.get(entry, "data") : null;
      if (typeof payload === "object" && payload !== null) {
        const command: unknown = Reflect.get(payload, "command");
        const backup: unknown = Reflect.get(payload, "backupId");
        if (typeof command === "string") run.command = command;
        if (typeof backup === "string" && !run.backups.includes(backup)) run.backups.push(backup);
      }
    }
  }
  return [...byRun.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Runs without an end entry whose last entry is younger than {@link RUN_STALE_MS}. */
export function openRuns(runs: readonly RunSummary[], now: number): RunSummary[] {
  return runs.filter((r) => !r.finished && now - r.lastAt < RUN_STALE_MS);
}
