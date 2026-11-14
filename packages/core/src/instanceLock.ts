import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ModuleHealth } from "./defineModule.ts";
import { KestrelBootError } from "./errors.ts";

/** Options for {@link acquireInstanceLock}. */
export interface InstanceLockOptions {
  /** The module taking the lock, named as `KestrelBootError.module` when another process holds it. */
  module: string;
  /** The setting that lets several processes share the database on purpose, quoted in the refusal. Default `allowConcurrentProcesses: true`. */
  optOut?: string;
  /** Milliseconds after the last heartbeat from which a lock counts as abandoned and may be taken over. Default 60000. */
  ttlMs?: number;
  /** Milliseconds between two heartbeats of the holder. Default 10000. */
  heartbeatMs?: number;
}

/** One holder's share of the instance lock on a database file. */
export interface InstanceLock {
  /** Gives up this holder's share; the lock file is removed with the last share in the process. Calling it again does nothing. */
  release(): void;
  /**
   * The lock's state, synchronous and without I/O. `ok: false` with `restartRequired: true` once a
   * heartbeat found the lock file owned by another instance: this process no longer holds the
   * database alone and has to restart.
   */
  health(): ModuleHealth;
}

interface LockRecord {
  instanceId: string;
  pid: number;
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

type Seen = { kind: "absent" } | { kind: "held"; raw: string; record: LockRecord } | { kind: "unreadable"; raw: string; mtimeMs: number };

interface Holder {
  lockPath: string;
  record: LockRecord;
  refs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  health: ModuleHealth;
}

const MEMORY = ":memory:";
const DEFAULT_OPT_OUT = "allowConcurrentProcesses: true";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const ATTEMPTS = 20;
const RETRY_PAUSE_MS = 20;
const GUARD_STALE_MS = 5_000;

const holders = new Map<string, Holder>();

const UNLOCKED: InstanceLock = {
  release() {},
  health: () => ({ ok: true }),
};

/**
 * The lock file for a database file: the file's real path with `.instance` appended, resolved
 * through symlinks so that every spelling of one database names the same lock. The lock also
 * writes short-lived siblings whose names start with this path. None of them belongs in a
 * replica, snapshot or backup of the database.
 */
export function instanceLockFile(file: string): string {
  return `${canonicalPath(file)}.instance`;
}

/**
 * Takes the lock that keeps a second process off the same database file. The lock is a sidecar
 * file next to the database (see {@link instanceLockFile}), never a row inside it, so it cannot
 * travel with a replica, snapshot or restore. `:memory:` takes no lock.
 *
 * A lock is taken over when its heartbeat is older than `ttlMs`, when it was written on this host
 * by a process that no longer runs, or when it carries this process's PID but an instance id this
 * process does not hold (a container restarted under the same PID). Any other lock makes the call
 * throw a `KestrelBootError` with code `instance-locked` naming that process's host, PID and start
 * time and the `optOut` setting. Several holders in one process share one lock; the last of them
 * to call `release()` deletes the lock file. The heartbeat runs on a timer that does not keep
 * the process alive.
 */
export function acquireInstanceLock(file: string, opts: InstanceLockOptions): InstanceLock {
  if (file === MEMORY) return UNLOCKED;
  const lockPath = instanceLockFile(file);
  const holder = holders.get(lockPath) ?? take(file, lockPath, opts);
  holder.refs++;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      holder.refs--;
      if (holder.refs === 0) drop(holder);
    },
    health: () => holder.health,
  };
}

function canonicalPath(file: string): string {
  const absolute = resolve(file);
  const tail: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return absolute;
      tail.unshift(basename(head));
      head = parent;
    }
  }
}

function take(file: string, lockPath: string, opts: InstanceLockOptions): Holder {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  mkdirSync(dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  const record: LockRecord = { instanceId: randomUUID(), pid: process.pid, host: hostname(), startedAt: now, heartbeatAt: now };
  const content = JSON.stringify(record);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(lockPath, content)) return hold(lockPath, record, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    const seen = readLock(lockPath);
    if (seen.kind === "absent") continue;
    if (!isStale(seen, ttlMs)) throw new KestrelBootError(opts.module, refusal(file, lockPath, seen, ttlMs, opts.optOut ?? DEFAULT_OPT_OUT), "instance-locked");
    const outcome = guarded(lockPath, () => replaceIf(lockPath, seen.raw, content));
    if (outcome === "replaced" && ownedBy(lockPath, record.instanceId)) return hold(lockPath, record, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    if (outcome === BUSY) pause(RETRY_PAUSE_MS);
  }
  throw new KestrelBootError(opts.module, `${file}: could not take the instance lock ${lockPath} because other processes kept changing it; retry once they have settled`, "instance-locked");
}

function hold(lockPath: string, record: LockRecord, heartbeatMs: number): Holder {
  const holder: Holder = { lockPath, record, refs: 0, timer: undefined, health: { ok: true } };
  holder.timer = setInterval(() => beat(holder), heartbeatMs);
  holder.timer.unref();
  holders.set(lockPath, holder);
  return holder;
}

function beat(holder: Holder): void {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const seen = readLock(holder.lockPath);
      if (seen.kind === "unreadable") return;
      if (seen.kind === "held" && seen.record.instanceId !== holder.record.instanceId) {
        lose(holder, seen.record);
        return;
      }
      holder.record.heartbeatAt = new Date().toISOString();
      const content = JSON.stringify(holder.record);
      const outcome = seen.kind === "absent" ? createExclusive(holder.lockPath, content) : guarded(holder.lockPath, () => replaceIf(holder.lockPath, seen.raw, content));
      if (outcome === BUSY) return;
      if (outcome === true || outcome === "replaced") {
        holder.health = { ok: true };
        return;
      }
    }
  } catch (err) {
    holder.health = { ok: true, note: `the heartbeat of ${holder.lockPath} could not be written: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function lose(holder: Holder, foreign: LockRecord): void {
  stop(holder);
  holder.health = {
    ok: false,
    restartRequired: true,
    reason: `the instance lock ${holder.lockPath} was taken over by host "${foreign.host}", pid ${foreign.pid} (started ${foreign.startedAt}); this process no longer holds the database alone`,
  };
}

function stop(holder: Holder): void {
  if (holder.timer !== undefined) clearInterval(holder.timer);
  holder.timer = undefined;
}

function drop(holder: Holder): void {
  const lost = !holder.health.ok;
  stop(holder);
  holders.delete(holder.lockPath);
  if (!lost) guarded(holder.lockPath, () => removeIfOwned(holder.lockPath, holder.record.instanceId));
}

function removeIfOwned(lockPath: string, instanceId: string): void {
  if (ownedBy(lockPath, instanceId)) rmSync(lockPath, { force: true });
}

function ownedBy(lockPath: string, instanceId: string): boolean {
  try {
    const seen = readLock(lockPath);
    return seen.kind === "held" && seen.record.instanceId === instanceId;
  } catch {
    return false;
  }
}

function createExclusive(path: string, content: string): boolean {
  const tmp = siblingPath(path, "tmp");
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (errorCode(err) === "EEXIST") return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

function siblingPath(path: string, suffix: string): string {
  return `${path}.${randomUUID()}.${suffix}`;
}

const BUSY = Symbol("busy");

function guarded<T>(lockPath: string, fn: () => T): T | typeof BUSY {
  const guard = `${lockPath}.takeover`;
  const token = randomUUID();
  if (!createExclusive(guard, token)) {
    clearAbandonedGuard(guard);
    return BUSY;
  }
  try {
    return fn();
  } finally {
    if (readQuietly(guard) === token) rmSync(guard, { force: true });
  }
}

function clearAbandonedGuard(guard: string): void {
  let token: string;
  try {
    token = readFileSync(guard, "utf8");
    if (Date.now() - statSync(guard).mtimeMs <= GUARD_STALE_MS) return;
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  const aside = siblingPath(guard, "stale");
  try {
    renameSync(guard, aside);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  try {
    if (readQuietly(aside) !== token) linkSync(aside, guard);
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  } finally {
    rmSync(aside, { force: true });
  }
}

function replaceIf(lockPath: string, expected: string, content: string): "replaced" | "changed" {
  if (readQuietly(lockPath) !== expected) return "changed";
  const tmp = siblingPath(lockPath, "tmp");
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, lockPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return "replaced";
}

function readQuietly(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

function readLock(lockPath: string): Seen {
  const raw = readQuietly(lockPath);
  if (raw === undefined) return { kind: "absent" };
  const record = parseRecord(raw);
  if (record !== undefined) return { kind: "held", raw, record };
  try {
    return { kind: "unreadable", raw, mtimeMs: statSync(lockPath).mtimeMs };
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { kind: "absent" };
    throw err;
  }
}

function isStale(seen: Exclude<Seen, { kind: "absent" }>, ttlMs: number): boolean {
  if (seen.kind === "unreadable") return Date.now() - seen.mtimeMs > ttlMs;
  const { record } = seen;
  if (!(Date.now() - Date.parse(record.heartbeatAt) <= ttlMs)) return true;
  if (record.host !== hostname()) return false;
  return record.pid === process.pid || !isAlive(record.pid);
}

function refusal(file: string, lockPath: string, seen: Exclude<Seen, { kind: "absent" }>, ttlMs: number, optOut: string): string {
  const advice = `Stop that process, or set ${optOut} to run several processes on this database on purpose.`;
  if (seen.kind === "unreadable") {
    return `${file} is locked by ${lockPath}, which is unreadable and was written within the last ${Math.round(ttlMs / 1000)} s; it is taken over once it is older. ${advice}`;
  }
  const { record } = seen;
  return `${file} is in use by another process: host "${record.host}", pid ${record.pid}, started ${record.startedAt}, last heartbeat ${record.heartbeatAt} (lock file ${lockPath}). ${advice}`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return errorCode(err) === "EPERM";
  }
}

function parseRecord(raw: string): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (!("instanceId" in value && "pid" in value && "host" in value && "startedAt" in value && "heartbeatAt" in value)) return undefined;
  const { instanceId, pid, host, startedAt, heartbeatAt } = value;
  if (typeof instanceId !== "string" || typeof host !== "string" || typeof startedAt !== "string" || typeof heartbeatAt !== "string") return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || Number.isNaN(Date.parse(heartbeatAt))) return undefined;
  return { instanceId, pid, host, startedAt, heartbeatAt };
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
