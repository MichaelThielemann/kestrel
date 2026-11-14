import { hostname } from "node:os";
import { OpsError } from "./errors.ts";
import { jsonBytes, keys } from "./layout.ts";
import type { ObjectStore } from "./store.ts";

/** A held lock as the trace in the backup location shows it. */
export interface HeldLock {
  runId: string;
  command: string;
  host: string;
  pid: number;
  since: number;
  lastBeat: number;
}

/** How long a lock without a heartbeat still counts as held. */
export const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const BEAT_MS = 10 * 60 * 1000;

/** Locks whose trace has no release entry and whose last heartbeat is younger than {@link LOCK_STALE_MS}. */
export async function heldLocks(store: ObjectStore, location: string, now: number): Promise<HeldLock[]> {
  const byRun = new Map<string, { start: string | null; released: boolean; since: number; lastBeat: number }>();
  for (const info of await store.list(`${location}locks/`)) {
    const m = /locks\/([^/]+)\/\d{8}T\d{6}Z-(start|beat|released)-[0-9a-f]{4}\.json$/.exec(info.key);
    if (!m) continue;
    const runId = m[1] ?? "";
    const entry = byRun.get(runId) ?? { start: null, released: false, since: info.lastModified, lastBeat: info.lastModified };
    if (m[2] === "start") entry.start = info.key;
    if (m[2] === "released") entry.released = true;
    entry.since = Math.min(entry.since, info.lastModified);
    entry.lastBeat = Math.max(entry.lastBeat, info.lastModified);
    byRun.set(runId, entry);
  }
  const out: HeldLock[] = [];
  for (const [runId, entry] of byRun) {
    if (entry.released || now - entry.lastBeat >= LOCK_STALE_MS || entry.start === null) continue;
    const data = await store.get(entry.start);
    const parsed: unknown = data === null ? {} : JSON.parse(new TextDecoder().decode(data));
    const field = (name: string): unknown => (typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, name) : undefined);
    const command = field("command");
    const host = field("host");
    const pid = field("pid");
    out.push({ runId, command: typeof command === "string" ? command : "", host: typeof host === "string" ? host : "", pid: typeof pid === "number" ? pid : 0, since: entry.since, lastBeat: entry.lastBeat });
  }
  return out;
}

/** A lock this run took. */
export interface Lock {
  release(): Promise<void>;
}

/**
 * Takes the tool's lock for a run. The store offers no conditional write, so the lock is a trace of write-once keys:
 * a start entry, a heartbeat every ten minutes and a release entry. It refuses when another run holds one; the hard
 * serialization of runs belongs to whatever starts them (one operator, or an exclusive CI environment).
 */
export async function acquireLock(store: ObjectStore, location: string, runId: string, command: string, clock: () => number): Promise<Lock> {
  const others = (await heldLocks(store, location, clock())).filter((l) => l.runId !== runId);
  const other = others[0];
  if (other) throw new OpsError(`another run holds the lock: ${other.runId} (${other.command}) on ${other.host}, pid ${other.pid}, since ${new Date(other.since).toISOString()}`, 1, "lock");
  await store.put(location + keys.lock(runId, clock(), "start"), jsonBytes({ runId, command, host: hostname(), pid: process.pid, at: clock() }), { contentType: "application/json" });
  const timer = setInterval(() => {
    store.put(location + keys.lock(runId, clock(), "beat"), jsonBytes({ runId, at: clock() }), { contentType: "application/json" }).catch(() => undefined);
  }, BEAT_MS);
  timer.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await store.put(location + keys.lock(runId, clock(), "released"), jsonBytes({ runId, at: clock() }), { contentType: "application/json" });
    },
  };
}
