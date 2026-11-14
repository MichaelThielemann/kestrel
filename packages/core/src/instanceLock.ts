import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ModuleHealth } from "./defineModule.ts";
import { boundaryCast } from "./cast.ts";
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
  pidNamespace: string;
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
const SAME_PROCESS_SLACK_MS = 1_000;
const MAX_LINK_HOPS = 40;
const HOLDERS_KEY = Symbol.for("kestrel.instanceLocks");

const holders = sharedHolders();
const PID_NAMESPACE = pidNamespace();
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000;

const UNLOCKED: InstanceLock = {
  release() {},
  health: () => ({ ok: true }),
};

function sharedHolders(): Map<string, Holder> {
  const existing: unknown = Reflect.get(globalThis, HOLDERS_KEY);
  if (existing instanceof Map) return boundaryCast<Map<string, Holder>>(existing, "host");
  const created = new Map<string, Holder>();
  Reflect.set(globalThis, HOLDERS_KEY, created);
  return created;
}

function pidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

/**
 * The lock file for a database file: the file's real path with `.instance` appended, resolved
 * through symlinks, including ones whose target does not exist yet, so that every spelling of
 * one database names the same lock before and after the database file is created. The lock also
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
 * A lock is taken over when its heartbeat is older than `ttlMs`. A lock written on this host in
 * this PID namespace is also taken over at once when its process no longer runs, or when it
 * carries this process's PID and a start time earlier than this process's own (a container
 * restarted under the same PID). A lock from another PID namespace, such as another container
 * with the same hostname, is judged by its heartbeat alone. Any other lock makes the call throw a
 * `KestrelBootError` with code `instance-locked` naming that process's host, PID and start time
 * and the `optOut` setting; `module` should be the calling module's name so that boot reports
 * that code.
 *
 * Several holders in one process share one lock, also across copies of this module and across
 * worker threads; the options of the first holder in a thread apply. The last holder in a thread
 * to call `release()` deletes the lock file, and a holder in another thread writes it again with
 * its next heartbeat. The heartbeat runs on a timer that does not keep the process alive.
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

function canonicalPath(file: string, hops = 0): string {
  const absolute = resolve(file);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    const path = join(canonicalPath(parent, hops), basename(absolute));
    const target = linkTarget(path);
    if (target === undefined || hops >= MAX_LINK_HOPS) return path;
    return canonicalPath(resolve(dirname(path), target), hops + 1);
  }
}

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function take(file: string, lockPath: string, opts: InstanceLockOptions): Holder {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  mkdirSync(dirname(lockPath), { recursive: true });
  const now = new Date().toISOString();
  const record: LockRecord = { instanceId: randomUUID(), pid: process.pid, pidNamespace: PID_NAMESPACE, host: hostname(), startedAt: now, heartbeatAt: now };
  const content = JSON.stringify(record);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (createExclusive(lockPath, content)) return hold(lockPath, record, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    const seen = readLock(lockPath);
    if (seen.kind === "absent") continue;
    const verdict = judge(seen, ttlMs);
    if (verdict === "taken") throw new KestrelBootError(opts.module, refusal(file, lockPath, seen, ttlMs, opts.optOut ?? DEFAULT_OPT_OUT), "instance-locked");
    if (verdict === "this-process" && seen.kind === "held") return hold(lockPath, { ...seen.record }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
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

function judge(seen: Exclude<Seen, { kind: "absent" }>, ttlMs: number): "stale" | "this-process" | "taken" {
  if (seen.kind === "unreadable") return Date.now() - seen.mtimeMs > ttlMs ? "stale" : "taken";
  const { record } = seen;
  if (!(Date.now() - Date.parse(record.heartbeatAt) <= ttlMs)) return "stale";
  if (record.host !== hostname() || record.pidNamespace !== PID_NAMESPACE) return "taken";
  if (record.pid === process.pid) return Date.parse(record.startedAt) < PROCESS_STARTED_AT - SAME_PROCESS_SLACK_MS ? "stale" : "this-process";
  return isAlive(record.pid) ? "taken" : "stale";
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
  if (!("instanceId" in value && "pid" in value && "pidNamespace" in value && "host" in value && "startedAt" in value && "heartbeatAt" in value)) return undefined;
  const { instanceId, pid, pidNamespace, host, startedAt, heartbeatAt } = value;
  if (typeof instanceId !== "string" || typeof pidNamespace !== "string" || typeof host !== "string" || typeof startedAt !== "string" || typeof heartbeatAt !== "string") return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(heartbeatAt))) return undefined;
  return { instanceId, pid, pidNamespace, host, startedAt, heartbeatAt };
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
