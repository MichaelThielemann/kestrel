import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import type { ModuleHealth } from "./defineModule.ts";
import { boundaryCast } from "./cast.ts";
import { KestrelBootError } from "./errors.ts";

/** Options for {@link acquireInstanceLock}. Within one thread only the first holder's options take effect. */
export interface InstanceLockOptions {
  /** The module taking the lock, named as `KestrelBootError.module` when another process holds it. */
  module: string;
  /** The setting that lets several processes share the database on purpose, quoted in the refusal. Default `allowConcurrentProcesses: true`. */
  optOut?: string;
  /**
   * Milliseconds after the last heartbeat from which a lock counts as abandoned and may be taken
   * over. Default 60000. The lock file records it, and a lock is judged by the longer of the TTL
   * it records and the caller's.
   */
  ttlMs?: number;
  /** Milliseconds between two heartbeats of the holder, at most a third of `ttlMs`. Default 10000, or a third of `ttlMs` when that is shorter. */
  heartbeatMs?: number;
}

/** One holder's share of the instance lock on a database file. */
export interface InstanceLock {
  /**
   * Gives up this holder's share; the lock file is removed with the last share in the process.
   * Calling it again does nothing. It waits for up to 6 s while another process is in the middle
   * of changing the lock file. It never throws: a lock file it cannot remove is taken over
   * once its heartbeat is older than the TTL, or at once in this PID namespace once the process
   * has ended.
   */
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
  processStart: string;
  bootId: string;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  ttlMs: number;
  threads: Record<string, string>;
}

type Seen = { kind: "absent" } | { kind: "held"; raw: string; record: LockRecord } | { kind: "unreadable"; raw: string; mtimeMs: number };

interface GuardLabel {
  token: string;
  pid: number;
  pidNamespace: string;
  processStart: string;
  bootId: string;
  host: string;
}

interface Holder {
  lockPath: string;
  record: LockRecord;
  token: string;
  ttlMs: number;
  refs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  onExit: () => void;
  health: ModuleHealth;
}

const MEMORY = ":memory:";
const URI_SCHEME = "file:";
const DEFAULT_OPT_OUT = "allowConcurrentProcesses: true";
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const ATTEMPTS = 20;
const RETRY_PAUSE_MS = 20;
const GUARD_STALE_MS = 5_000;
const GUARD_WAIT_MS = GUARD_STALE_MS + 1_000;
const SAME_PROCESS_SLACK_MS = 1_000;
const MAX_LINK_HOPS = 40;
const MAX_TIMER_MS = 2 ** 31 - 1;
const HOLDERS_KEY = Symbol.for("kestrel.instanceLocks");

const holders = sharedHolders();
const PID_NAMESPACE = pidNamespace();
const PROCESS_START = statOf("self")?.start ?? "";
const PROC_SHOWS_PIDS = PROCESS_START !== "" && statOf(process.pid)?.start === PROCESS_START;
const BOOT_ID = bootId();
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

function statOf(pid: number | "self"): { state: string; start: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0] ?? "", start: fields[19] ?? "" };
  } catch {
    return undefined;
  }
}

function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * The lock file for a database file: the file's real path with `.instance` appended, resolved
 * through symlinks, including ones whose target does not exist yet, and with each `..` applied
 * to the directory a symlink leads to, as the system opens the file, so that every spelling of
 * one database names the same lock before and after the database file is created. A SQLite
 * `file:` URI names the lock of the file in its path. `undefined` for a name that takes no lock
 * (see {@link acquireInstanceLock}): an in-memory or temporary database. The lock also
 * writes short-lived siblings whose names start with this path; a process that ends abruptly
 * can leave one behind, and the next process to take the lock removes those older than the TTL.
 * None of them belongs in a replica, snapshot or backup of the database.
 */
export function instanceLockFile(file: string): string | undefined {
  const path = databasePath(file);
  return path === undefined ? undefined : `${canonicalPath(path)}.instance`;
}

/**
 * Takes the lock that keeps a second process off the same database file. The lock is a sidecar
 * file next to the database (see {@link instanceLockFile}), never a row inside it, so it cannot
 * travel with a replica, snapshot or restore. An in-memory or temporary database takes no lock:
 * `:memory:`, the empty name, and a `file:` URI with the path `:memory:`, an empty path or
 * `mode=memory`.
 *
 * A lock is taken over when its heartbeat is older than the longer of `ttlMs` and the TTL the
 * lock file records. A lock written on this machine (the same Linux boot id, or the same hostname
 * where the system has none) in this PID namespace is also taken over at once when its process no
 * longer runs: no process has its PID, or, where `/proc` shows it, the process under that PID is a
 * zombie or has another start time than the one the lock records. A lock from another machine or
 * another PID namespace, such as another container with the same hostname, is judged by its
 * heartbeat alone. Any lock that is not taken over makes the call throw a `KestrelBootError` with
 * code `instance-locked` at once; the reason names that process's host, PID and start time, the
 * time from which the lock is taken over and the `optOut` setting. While another process is in
 * the middle of taking over or releasing the lock, the call waits for it for up to 6 s and then
 * throws `instance-locked` naming that process; a process on this machine and in this PID
 * namespace that died in that moment is noticed at once, one elsewhere after 5 s. A container restarted after
 * its process was killed usually runs in a new PID namespace and fails to boot until the TTL
 * after the previous run's last heartbeat; only when the kernel gave the new namespace the id of
 * the old one is the lock judged by PID and start time and taken over at once. A process that
 * ends through the end of its event loop, `process.exit()` or an uncaught exception gives up its
 * shares on exit as `release()` does. Invalid `ttlMs` or `heartbeatMs` throw a `KestrelBootError`
 * with code `invalid-module-config`. `module` should be the calling module's name so that boot
 * reports these codes.
 *
 * Several holders in one process share one lock, also across copies of this module and across
 * worker threads; the last of them to call `release()` deletes the lock file. Once another
 * instance took the lock over, the next call does not join the lost share but takes the lock
 * anew or throws like a first call. A thread that
 * ends without releasing stops counting once its share is older than `ttlMs`. The heartbeat runs
 * on a timer that does not keep the process alive.
 */
export function acquireInstanceLock(file: string, opts: InstanceLockOptions): InstanceLock {
  const timing = timingOf(opts);
  const lockPath = instanceLockFile(file);
  if (lockPath === undefined) return UNLOCKED;
  const current = holders.get(lockPath);
  if (current !== undefined && !current.health.ok) holders.delete(lockPath);
  const holder = current?.health.ok === true ? current : take(file, lockPath, opts, timing);
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

interface Timing {
  ttlMs: number;
  heartbeatMs: number;
}

function timingOf(opts: InstanceLockOptions): Timing {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!(Number.isFinite(ttlMs) && ttlMs > 0)) throw invalidOption(opts, `ttlMs must be a positive number of milliseconds, got ${ttlMs}`);
  const heartbeatMs = opts.heartbeatMs ?? Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(ttlMs / 3));
  if (!(heartbeatMs > 0 && heartbeatMs <= MAX_TIMER_MS)) throw invalidOption(opts, `heartbeatMs must be a positive number of milliseconds up to ${MAX_TIMER_MS}, got ${heartbeatMs}`);
  if (heartbeatMs * 3 > ttlMs) throw invalidOption(opts, `heartbeatMs (${heartbeatMs}) must be at most a third of ttlMs (${ttlMs}), so that a lock outlives two missed heartbeats`);
  return { ttlMs, heartbeatMs };
}

function invalidOption(opts: InstanceLockOptions, reason: string): KestrelBootError {
  return new KestrelBootError(opts.module, `instance lock: ${reason}`, "invalid-module-config");
}

function databasePath(file: string): string | undefined {
  if (file === "" || file === MEMORY) return undefined;
  if (!file.startsWith(URI_SCHEME)) return file;
  const rest = file.slice(URI_SCHEME.length);
  const end = rest.search(/[?#]/);
  const query = end === -1 ? "" : rest.slice(end + 1).split("#")[0];
  let path = end === -1 ? rest : rest.slice(0, end);
  if (path.startsWith("//")) {
    const slash = path.indexOf("/", 2);
    path = slash === -1 ? "" : path.slice(slash);
  }
  path = decoded(path);
  if (path === "" || path === MEMORY || new URLSearchParams(query).get("mode") === "memory") return undefined;
  return path;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function canonicalPath(file: string): string {
  const absolute = isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`;
  try {
    return realpathSync.native(absolute);
  } catch {
    return physicalPath(absolute);
  }
}

function physicalPath(absolute: string): string {
  let current = parse(absolute).root;
  const pending = absolute.slice(current.length).split(sep).reverse();
  let hops = 0;
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const path = join(current, part);
    const target = hops < MAX_LINK_HOPS ? linkTarget(path) : undefined;
    if (target === undefined) {
      current = path;
      continue;
    }
    hops++;
    const root = isAbsolute(target) ? parse(target).root : "";
    if (root !== "") current = root;
    pending.push(...target.slice(root.length).split(sep).reverse());
  }
  return current;
}

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

function take(file: string, lockPath: string, opts: InstanceLockOptions, { ttlMs, heartbeatMs }: Timing): Holder {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const now = new Date().toISOString();
  const record: LockRecord = {
    instanceId: randomUUID(),
    pid: process.pid,
    pidNamespace: PID_NAMESPACE,
    processStart: PROCESS_START,
    bootId: BOOT_ID,
    host: hostname(),
    startedAt: now,
    heartbeatAt: now,
    ttlMs,
    threads: { [token]: now },
  };
  const owned = claim(file, lockPath, record, token, ttlMs, opts);
  sweep(lockPath, ttlMs);
  return hold(lockPath, owned, token, ttlMs, heartbeatMs);
}

function claim(file: string, lockPath: string, record: LockRecord, token: string, ttlMs: number, opts: InstanceLockOptions): LockRecord {
  const content = JSON.stringify(record);
  const deadline = performance.now() + GUARD_WAIT_MS;
  for (let changes = 0; changes < ATTEMPTS; ) {
    if (createExclusive(lockPath, content)) return record;
    const seen = readLock(lockPath);
    if (seen.kind === "absent") {
      changes++;
      continue;
    }
    const verdict = judge(seen, ttlMs);
    if (verdict === "taken") throw new KestrelBootError(opts.module, refusal(file, lockPath, seen, ttlMs, opts.optOut ?? DEFAULT_OPT_OUT), "instance-locked");
    const joining = verdict === "this-process" && seen.kind === "held";
    const next = joining ? renewed(seen.record, token, ttlMs) : record;
    const outcome = guarded(lockPath, () => replaceIf(lockPath, seen.raw, JSON.stringify(next)));
    if (outcome === BUSY) {
      if (performance.now() >= deadline) throw new KestrelBootError(opts.module, guardRefusal(file, lockPath), "instance-locked");
      pause(RETRY_PAUSE_MS);
      continue;
    }
    if (outcome === "replaced" && (joining || ownedBy(lockPath, record.instanceId))) return next;
    changes++;
  }
  throw new KestrelBootError(opts.module, `${file}: could not take the instance lock ${lockPath} because other processes kept changing it; retry once they have settled`, "instance-locked");
}

function guardRefusal(file: string, lockPath: string): string {
  const guard = guardPath(lockPath);
  const label = parseGuard(readQuietly(guard) ?? "");
  const holder = label === undefined ? "a process that did not name itself" : `host "${label.host}", pid ${label.pid}`;
  return `${file}: could not take the instance lock ${lockPath} because ${holder} kept its takeover marker ${guard} for more than ${GUARD_WAIT_MS / 1000} s; retry once that process has finished`;
}

function renewed(record: LockRecord, token: string, ttlMs: number): LockRecord {
  const now = new Date();
  const ttl = Math.max(record.ttlMs, ttlMs);
  const threads = Object.entries({ ...record.threads, [token]: now.toISOString() }).filter(([, at]) => now.getTime() - Date.parse(at) <= ttl);
  return { ...record, heartbeatAt: now.toISOString(), ttlMs: ttl, threads: Object.fromEntries(threads) };
}

function hold(lockPath: string, record: LockRecord, token: string, ttlMs: number, heartbeatMs: number): Holder {
  const holder: Holder = { lockPath, record, token, ttlMs, refs: 0, timer: undefined, onExit: () => drop(holder), health: { ok: true } };
  holder.timer = setInterval(() => beat(holder), heartbeatMs);
  holder.timer.unref();
  process.on("exit", holder.onExit);
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
      const next = renewed(seen.kind === "held" ? seen.record : { ...holder.record, threads: {} }, holder.token, holder.ttlMs);
      const content = JSON.stringify(next);
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
  process.off("exit", holder.onExit);
}

function drop(holder: Holder): void {
  const lost = !holder.health.ok;
  stop(holder);
  if (holders.get(holder.lockPath) === holder) holders.delete(holder.lockPath);
  if (lost) return;
  const deadline = performance.now() + GUARD_WAIT_MS;
  for (;;) {
    try {
      if (guarded(holder.lockPath, () => leave(holder)) !== BUSY) return;
    } catch {
      return;
    }
    if (performance.now() >= deadline) return;
    pause(RETRY_PAUSE_MS);
  }
}

function leave(holder: Holder): void {
  const seen = readLock(holder.lockPath);
  if (seen.kind !== "held" || seen.record.instanceId !== holder.record.instanceId) return;
  const now = Date.now();
  const ttl = Math.max(holder.ttlMs, seen.record.ttlMs);
  const others = Object.entries(seen.record.threads).filter(([token, at]) => token !== holder.token && now - Date.parse(at) <= ttl);
  if (others.length === 0) rmSync(holder.lockPath, { force: true });
  else replaceIf(holder.lockPath, seen.raw, JSON.stringify({ ...seen.record, threads: Object.fromEntries(others) }));
}

function sweep(lockPath: string, ttlMs: number): void {
  const dir = dirname(lockPath);
  const leftover = new RegExp(`^${escapeRegExp(basename(lockPath))}\\.(takeover\\.)?[0-9a-f-]{36}\\.(tmp|stale)$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => leftover.test(n))) {
    const path = join(dir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > ttlMs) rmSync(path, { force: true });
    } catch {
      continue;
    }
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function guardPath(lockPath: string): string {
  return `${lockPath}.takeover`;
}

function guarded<T>(lockPath: string, fn: () => T): T | typeof BUSY {
  const guard = guardPath(lockPath);
  const label: GuardLabel = { token: randomUUID(), pid: process.pid, pidNamespace: PID_NAMESPACE, processStart: PROCESS_START, bootId: BOOT_ID, host: hostname() };
  const content = JSON.stringify(label);
  if (!createExclusive(guard, content)) {
    clearAbandonedGuard(guard);
    return BUSY;
  }
  try {
    return fn();
  } finally {
    if (readQuietly(guard) === content) rmSync(guard, { force: true });
  }
}

function clearAbandonedGuard(guard: string): void {
  let raw: string;
  try {
    raw = readFileSync(guard, "utf8");
    if (!guardAbandoned(parseGuard(raw), statSync(guard).mtimeMs)) return;
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
    if (readQuietly(aside) !== raw) linkSync(aside, guard);
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw err;
  } finally {
    rmSync(aside, { force: true });
  }
}

function guardAbandoned(label: GuardLabel | undefined, mtimeMs: number): boolean {
  if (label === undefined || !sameKernel(label) || label.pidNamespace !== PID_NAMESPACE) return Date.now() - mtimeMs > GUARD_STALE_MS;
  if (label.pid !== process.pid) return !runs(label.pid, label.processStart);
  return PROCESS_START !== "" && label.processStart !== "" && label.processStart !== PROCESS_START;
}

function parseGuard(raw: string): GuardLabel | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if (!("token" in value && "pid" in value && "pidNamespace" in value && "processStart" in value && "bootId" in value && "host" in value)) return undefined;
  const { token, pid, pidNamespace, processStart, bootId, host } = value;
  if (typeof token !== "string" || typeof pidNamespace !== "string" || typeof processStart !== "string" || typeof bootId !== "string" || typeof host !== "string") return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  return { token, pid, pidNamespace, processStart, bootId, host };
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
  if (!(Date.now() - Date.parse(record.heartbeatAt) <= Math.max(ttlMs, record.ttlMs))) return "stale";
  if (!sameKernel(record) || record.pidNamespace !== PID_NAMESPACE) return "taken";
  if (record.pid === process.pid) return sameProcess(record) ? "this-process" : "stale";
  return runs(record.pid, record.processStart) ? "taken" : "stale";
}

function sameKernel(record: { bootId: string; host: string }): boolean {
  if (BOOT_ID !== "" && record.bootId !== "") return record.bootId === BOOT_ID;
  return record.host === hostname();
}

function sameProcess(record: LockRecord): boolean {
  if (PROCESS_START !== "" && record.processStart !== "") return record.processStart === PROCESS_START;
  return Date.parse(record.startedAt) >= PROCESS_STARTED_AT - SAME_PROCESS_SLACK_MS;
}

function refusal(file: string, lockPath: string, seen: Exclude<Seen, { kind: "absent" }>, ttlMs: number, optOut: string): string {
  const advice = `Stop that process, or set ${optOut} to run several processes on this database on purpose.`;
  if (seen.kind === "unreadable") {
    return `${file} is locked by ${lockPath}, which is unreadable and was written within the last ${Math.round(ttlMs / 1000)} s; it is taken over once it is older. ${advice}`;
  }
  const { record } = seen;
  const expiry = new Date(Date.parse(record.heartbeatAt) + Math.max(ttlMs, record.ttlMs)).toISOString();
  const earlierRun =
    sameKernel(record) && record.pidNamespace !== PID_NAMESPACE
      ? ` The lock comes from another PID namespace on this host, such as an earlier run of this container; if no process uses the database any more, delete ${lockPath} to start at once.`
      : "";
  return `${file} is in use by another process: host "${record.host}", pid ${record.pid}, started ${record.startedAt}, last heartbeat ${record.heartbeatAt} (lock file ${lockPath}). The lock is taken over automatically from ${expiry} if that process sends no further heartbeat.${earlierRun} ${advice}`;
}

function runs(pid: number, start: string): boolean {
  if (!isAlive(pid)) return false;
  const stat = PROC_SHOWS_PIDS ? statOf(pid) : undefined;
  if (stat === undefined) return true;
  if (stat.state === "Z" || stat.state === "X") return false;
  return start === "" || stat.start === start;
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
  if (!("instanceId" in value && "pid" in value && "pidNamespace" in value && "processStart" in value && "bootId" in value && "host" in value && "startedAt" in value && "heartbeatAt" in value && "ttlMs" in value && "threads" in value)) return undefined;
  const { instanceId, pid, pidNamespace, processStart, bootId, host, startedAt, heartbeatAt, ttlMs, threads } = value;
  if (typeof instanceId !== "string" || typeof pidNamespace !== "string" || typeof processStart !== "string" || typeof bootId !== "string" || typeof host !== "string") return undefined;
  if (typeof startedAt !== "string" || typeof heartbeatAt !== "string" || !isThreads(threads)) return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || Number.isNaN(Date.parse(startedAt)) || Number.isNaN(Date.parse(heartbeatAt))) return undefined;
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) return undefined;
  return { instanceId, pid, pidNamespace, processStart, bootId, host, startedAt, heartbeatAt, ttlMs, threads };
}

function isThreads(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((at) => typeof at === "string" && !Number.isNaN(Date.parse(at)));
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
