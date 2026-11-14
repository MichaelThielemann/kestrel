import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KestrelBootError } from "./errors.ts";
import { acquireInstanceLock, instanceLockFile, type InstanceLock } from "./instanceLock.ts";

interface LockRecord {
  instanceId: string;
  pid: number;
  pidNamespace: string;
  processStart: string;
  clockStart: number;
  bootId: string;
  host: string;
  startedAt: string;
  heartbeatAt: string;
  ttlMs: number;
  threads: Record<string, string>;
}

function ownPidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

function statFields(pid: number | "self"): string[] {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return [];
  }
}

function startOf(pid: number | "self"): string {
  return statFields(pid)[19] ?? "";
}

function ownProcessStart(): string {
  return startOf("self");
}

function ownBootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

const onThisHost = { host: hostname(), bootId: ownBootId() };

const FOREIGN_PID_NAMESPACE = "pid:[4026530001]";

function beforeThisProcess(): string {
  return new Date(Date.now() - process.uptime() * 1000 - 60_000).toISOString();
}

const LOCK_MODULE = new URL("./instanceLock.ts", import.meta.url).href;

let dir: string;
let file: string;
const held: InstanceLock[] = [];
const children: ChildProcess[] = [];

function take(path: string, opts: Partial<Parameters<typeof acquireInstanceLock>[1]> = {}): InstanceLock {
  const lock = acquireInstanceLock(path, { module: "store/sqlite", ...opts });
  held.push(lock);
  return lock;
}

function lockFile(path: string): string {
  const lockPath = instanceLockFile(path);
  if (lockPath === undefined) throw new Error(`${path} names no lock file`);
  return lockPath;
}

function readRecord(): LockRecord {
  const parsed: unknown = JSON.parse(readFileSync(lockFile(file), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("lock file is not an object");
  return { ...{ instanceId: "", pid: 0, pidNamespace: "", processStart: "", clockStart: 0, bootId: "", host: "", startedAt: "", heartbeatAt: "", ttlMs: 0, threads: {} }, ...parsed };
}

function writeRecord(record: Partial<LockRecord>): LockRecord {
  const now = new Date().toISOString();
  const full: LockRecord = { instanceId: randomUUID(), pid: 4242, pidNamespace: ownPidNamespace(), processStart: "1", clockStart: 1, bootId: randomUUID(), host: "other-host", startedAt: now, heartbeatAt: now, ttlMs: 60_000, threads: { [randomUUID()]: now }, ...record };
  writeFileSync(lockFile(file), JSON.stringify(full));
  return full;
}

function ownClockStart(): number {
  return Math.round(Number(process.hrtime.bigint()) / 1e6 - process.uptime() * 1000);
}

function writeGuard(holder: { pid: number; processStart?: string; pidNamespace?: string; host?: string; bootId?: string; threadId?: number }, ageMs = 0): string {
  const guard = `${lockFile(file)}.takeover`;
  writeFileSync(guard, JSON.stringify({ token: randomUUID(), pidNamespace: ownPidNamespace(), processStart: "1", threadId: 0, ...onThisHost, ...holder }));
  const at = new Date(Date.now() - ageMs);
  utimesSync(guard, at, at);
  return guard;
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  if (child.pid === undefined) throw new Error("could not start a child process");
  return child.pid;
}

function isRefCounted(value: unknown): value is { hasRef(): boolean } {
  return typeof value === "object" && value !== null && "hasRef" in value && typeof value.hasRef === "function";
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kestrel-lock-")));
  file = join(dir, "app.db");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const lock of held.splice(0)) lock.release();
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("instanceLockFile", () => {
  it("is the database file with .instance appended, next to it", () => {
    expect(lockFile(file)).toBe(`${file}.instance`);
  });

  it("names the same sidecar for every spelling of the same file", () => {
    expect(lockFile(join(dir, ".", "sub", "..", "app.db"))).toBe(lockFile(file));
  });

  it("follows a symlinked database file whose target does not exist yet, so the lock stays the same once it is created", () => {
    mkdirSync(join(dir, "vol"));
    mkdirSync(join(dir, "data"));
    symlinkSync(join("..", "vol", "app.db"), join(dir, "data", "app.db"));
    const before = lockFile(join(dir, "data", "app.db"));
    expect(before).toBe(`${join(dir, "vol", "app.db")}.instance`);
    writeFileSync(join(dir, "vol", "app.db"), "");
    expect(lockFile(join(dir, "data", "app.db"))).toBe(before);
    expect(lockFile(join(dir, "vol", "app.db"))).toBe(before);
  });

  it("resolves .. after a symlinked directory from the link's target, as SQLite opens the file", () => {
    mkdirSync(join(dir, "app", "releases", "7"), { recursive: true });
    mkdirSync(join(dir, "app", "releases", "shared"));
    symlinkSync(join("releases", "7"), join(dir, "app", "current"));
    const spelled = `${dir}/app/current/../shared/db.sqlite`;
    expect(lockFile(spelled)).toBe(`${join(dir, "app", "releases", "shared", "db.sqlite")}.instance`);
    writeFileSync(join(dir, "app", "releases", "shared", "db.sqlite"), "");
    expect(lockFile(spelled)).toBe(`${join(dir, "app", "releases", "shared", "db.sqlite")}.instance`);
  });

  it("resolves .. after a symlinked directory in a relative name from the link's target", () => {
    mkdirSync(join(dir, "app", "releases", "7"), { recursive: true });
    symlinkSync(join("releases", "7"), join(dir, "app", "current"));
    vi.spyOn(process, "cwd").mockReturnValue(join(dir, "app"));
    expect(lockFile("current/../shared/db.sqlite")).toBe(`${join(dir, "app", "releases", "shared", "db.sqlite")}.instance`);
  });

  it("takes one lock for every spelling of a database behind a symlinked directory", () => {
    mkdirSync(join(dir, "app", "releases", "7"), { recursive: true });
    mkdirSync(join(dir, "app", "releases", "shared"));
    symlinkSync(join("releases", "7"), join(dir, "app", "current"));
    take(`${dir}/app/current/../shared/db.sqlite`);
    take(join(dir, "app", "releases", "shared", "db.sqlite"));
    expect(existsSync(join(dir, "app", "shared"))).toBe(false);
    expect(existsSync(`${join(dir, "app", "releases", "shared", "db.sqlite")}.instance`)).toBe(true);
  });

  it("names no lock file for an in-memory or temporary database, which takes no lock", () => {
    for (const name of [":memory:", "", "file::memory:", "file::memory:?cache=shared", "file:memdb1?mode=memory&cache=shared", "file:", "file:?mode=ro", "file:/scratch?vfs=memdb", "file:/var/lib/app/app.db?vfs=memdb"]) {
      expect(instanceLockFile(name)).toBeUndefined();
    }
  });

  it("follows a symlinked directory whose target does not exist yet", () => {
    symlinkSync("missing", join(dir, "link"));
    expect(lockFile(join(dir, "link", "app.db"))).toBe(`${join(dir, "missing", "app.db")}.instance`);
  });
});

describe("acquireInstanceLock", () => {
  it("writes a sidecar next to the database with instance id, pid, pid namespace, host, start time and heartbeat", () => {
    take(file);
    const record = readRecord();
    expect(record.pid).toBe(process.pid);
    expect(record.pidNamespace).toBe(ownPidNamespace());
    expect(record.host).toBe(hostname());
    expect(record.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(Number.isNaN(Date.parse(record.heartbeatAt))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("creates the database's directory when it does not exist yet", () => {
    file = join(dir, "nested", "deeper", "app.db");
    take(file);
    expect(existsSync(lockFile(file))).toBe(true);
  });

  it("takes no lock and creates no file for an in-memory database", () => {
    const lock = take(":memory:");
    expect(existsSync(":memory:.instance")).toBe(false);
    expect(lock.health()).toEqual({ ok: true });
    lock.release();
  });

  it("takes no lock and creates no file for an empty file name, which opens a temporary database", () => {
    const lock = take("");
    expect(existsSync(`${process.cwd()}.instance`)).toBe(false);
    expect(lock.health()).toEqual({ ok: true });
  });

  it("takes no lock and creates no file for an in-memory or temporary database named by a file: URI", () => {
    for (const uri of ["file::memory:", "file::memory:?cache=shared", "file:memdb1?mode=memory&cache=shared", "file:", "file:/scratch?vfs=memdb", `file:${file}?vfs=memdb`]) {
      expect(take(uri).health()).toEqual({ ok: true });
    }
    expect(existsSync(lockFile(file))).toBe(false);
    expect(existsSync(join(process.cwd(), "file::memory:.instance"))).toBe(false);
    expect(existsSync(join(process.cwd(), "file:memdb1?mode=memory&cache=shared.instance"))).toBe(false);
  });

  it("locks the database file a file: URI names", () => {
    take(`file:${file}?mode=rwc`);
    expect(existsSync(lockFile(file))).toBe(true);
    expect(() => take(`file://${file}`)).not.toThrow();
    expect(lockFile(`file:${file}?mode=ro`)).toBe(lockFile(file));
    expect(lockFile(`file:${join(dir, "my%20app.db")}`)).toBe(`${join(dir, "my app.db")}.instance`);
  });

  it("is shared by several holders in one process, and the file disappears only with the last release", () => {
    const first = take(file);
    const second = take(join(dir, ".", "app.db"));
    const id = readRecord().instanceId;
    first.release();
    expect(existsSync(lockFile(file))).toBe(true);
    expect(readRecord().instanceId).toBe(id);
    first.release();
    expect(existsSync(lockFile(file))).toBe(true);
    second.release();
    expect(existsSync(lockFile(file))).toBe(false);
  });

  it("can be taken again after the last release", () => {
    take(file).release();
    take(file);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("refuses a fresh lock of a process on another host, naming host, pid, start time and the opt-out", () => {
    const foreign = writeRecord({ host: "web-2", pid: 311 });
    const err = thrownBy(() => take(file, { optOut: "allowConcurrentProcesses: true" }));
    expect(err).toBeInstanceOf(KestrelBootError);
    if (!(err instanceof KestrelBootError)) return;
    expect(err.code).toBe("instance-locked");
    expect(err.module).toBe("store/sqlite");
    expect(err.reason).toContain('"web-2"');
    expect(err.reason).toContain("311");
    expect(err.reason).toContain(foreign.startedAt);
    expect(err.reason).toContain("allowConcurrentProcesses: true");
    expect(err.reason).toContain(file);
    expect(readRecord()).toEqual(foreign);
  });

  it("names allowConcurrentProcesses as the opt-out when none is given", () => {
    writeRecord({});
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain("allowConcurrentProcesses");
  });

  it("refuses a fresh lock of another live process on the same host", () => {
    writeRecord({ ...onThisHost, pid: process.ppid, processStart: startOf(process.ppid) });
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.code : undefined).toBe("instance-locked");
  });

  it("takes over a lock whose heartbeat is older than the TTL, and only then", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const foreign = writeRecord({});
    vi.setSystemTime(new Date("2026-03-01T10:00:59.000Z"));
    expect(thrownBy(() => take(file))).toBeInstanceOf(KestrelBootError);
    vi.setSystemTime(new Date("2026-03-01T10:01:01.000Z"));
    take(file);
    const record = readRecord();
    expect(record.instanceId).not.toBe(foreign.instanceId);
    expect(record.pid).toBe(process.pid);
    expect(record.heartbeatAt).toBe("2026-03-01T10:01:01.000Z");
  });

  it("honours a custom TTL that both the holder and the caller use", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    writeRecord({ ttlMs: 5_000 });
    vi.setSystemTime(new Date("2026-03-01T10:00:06.000Z"));
    take(file, { ttlMs: 5_000, heartbeatMs: 1_000 });
    expect(readRecord().pid).toBe(process.pid);
  });

  it("records its TTL in the lock file", () => {
    take(file, { ttlMs: 30_000 });
    expect(readRecord().ttlMs).toBe(30_000);
  });

  it("judges a lock by its holder's TTL when that is longer than the caller's", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const foreign = writeRecord({ ttlMs: 60_000 });
    vi.setSystemTime(new Date("2026-03-01T10:00:06.000Z"));
    const err = thrownBy(() => take(file, { ttlMs: 5_000 }));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain("taken over automatically from 2026-03-01T10:01:00.000Z");
    expect(readRecord()).toEqual(foreign);
    vi.setSystemTime(new Date("2026-03-01T10:01:01.000Z"));
    take(file, { ttlMs: 5_000 });
    expect(readRecord().pid).toBe(process.pid);
  });

  it("keeps the longer TTL in the lock file when a thread with a shorter one joins it", () => {
    writeRecord({ ...onThisHost, pid: process.pid, processStart: ownProcessStart(), ttlMs: 60_000 });
    take(file, { ttlMs: 6_000 });
    expect(readRecord().ttlMs).toBe(60_000);
  });

  it("beats at most every third of a custom TTL when no heartbeat is given", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    take(file, { ttlMs: 6_000 });
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
  });

  it("rejects a TTL or heartbeat that is not a positive number, a heartbeat longer than a third of the TTL, or one beyond the timer range", () => {
    const invalid = [{ ttlMs: 0 }, { ttlMs: -1 }, { ttlMs: Number.NaN }, { ttlMs: Number.POSITIVE_INFINITY }, { heartbeatMs: 0 }, { heartbeatMs: -5 }, { heartbeatMs: Number.NaN }, { ttlMs: 30_000, heartbeatMs: 10_001 }, { ttlMs: 2 ** 34, heartbeatMs: 2 ** 31 }];
    for (const opts of invalid) {
      const err = thrownBy(() => take(file, opts));
      expect(err).toBeInstanceOf(KestrelBootError);
      expect(err instanceof KestrelBootError ? [err.code, err.module] : []).toEqual(["invalid-module-config", "store/sqlite"]);
    }
    expect(existsSync(lockFile(file))).toBe(false);
  });

  it("takes over at once a lock of a dead process on the same host", () => {
    const foreign = writeRecord({ ...onThisHost, pid: deadPid() });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
    expect(readRecord().pid).toBe(process.pid);
  });

  it.runIf(ownProcessStart() !== "")("takes over at once a lock whose pid now belongs to another process on this host that started at another time", () => {
    const foreign = writeRecord({ ...onThisHost, pid: process.ppid, processStart: String(Number(startOf(process.ppid)) - 1) });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
  });

  it.runIf(ownProcessStart() !== "")("takes over at once a lock of a process on this host that has ended but was not reaped yet", async () => {
    const parent = spawn("/bin/sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(parent);
    const zombie = await new Promise<number>((resolve) => parent.stdout?.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim()))));
    const start = startOf(zombie);
    while (statFields(zombie)[0] !== "Z") await new Promise((resolve) => setTimeout(resolve, 10));
    const foreign = writeRecord({ ...onThisHost, pid: zombie, processStart: start });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
  });

  it("takes over at once a lock with this process's pid and pid namespace that an earlier process under that pid wrote", () => {
    const foreign = writeRecord({ ...onThisHost, pid: process.pid, startedAt: beforeThisProcess() });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("shares a lock that another thread of this process holds instead of taking it over", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const sibling = writeRecord({ ...onThisHost, pid: process.pid, processStart: ownProcessStart() });
    const lock = take(file);
    expect(readRecord().instanceId).toBe(sibling.instanceId);
    vi.advanceTimersByTime(10_000);
    expect(lock.health()).toEqual({ ok: true });
    expect(readRecord().instanceId).toBe(sibling.instanceId);
  });

  it.runIf(ownProcessStart() !== "")("shares a lock of this process even when its wall-clock start time lies before this process's start", () => {
    const sibling = writeRecord({ ...onThisHost, pid: process.pid, processStart: ownProcessStart(), startedAt: beforeThisProcess() });
    const lock = take(file);
    expect(readRecord().instanceId).toBe(sibling.instanceId);
    expect(lock.health()).toEqual({ ok: true });
  });

  it("keeps the lock file on the last release in this thread while another thread of this process still holds it", () => {
    const sibling = writeRecord({ ...onThisHost, pid: process.pid, processStart: ownProcessStart() });
    take(file).release();
    expect(readRecord().instanceId).toBe(sibling.instanceId);
    expect(Object.keys(readRecord().threads)).toEqual(Object.keys(sibling.threads));
  });

  it("removes the lock file on release once no other thread of this process has renewed its share within the TTL", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    writeRecord({ ...onThisHost, pid: process.pid, processStart: ownProcessStart() });
    const lock = take(file);
    vi.advanceTimersByTime(70_000);
    lock.release();
    expect(existsSync(lockFile(file))).toBe(false);
  });

  it.runIf(ownBootId() !== "")("refuses a fresh lock from another machine with the same hostname and pid namespace, even when no process here has its pid", () => {
    writeRecord({ host: hostname(), bootId: randomUUID(), pid: deadPid() });
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.code : undefined).toBe("instance-locked");
  });

  it("refuses a fresh lock of a process on this host in another pid namespace, even when no process here has its pid", () => {
    writeRecord({ ...onThisHost, pid: deadPid(), pidNamespace: FOREIGN_PID_NAMESPACE });
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.code : undefined).toBe("instance-locked");
  });

  it("tells when a refused lock is taken over, and how to start at once when it is left by an earlier run in another pid namespace", () => {
    const heartbeatAt = new Date(Date.now() - 5_000);
    writeRecord({ ...onThisHost, pid: 1, pidNamespace: FOREIGN_PID_NAMESPACE, heartbeatAt: heartbeatAt.toISOString() });
    const err = thrownBy(() => take(file));
    const reason = err instanceof KestrelBootError ? err.reason : "";
    expect(reason).toContain(`taken over automatically from ${new Date(heartbeatAt.getTime() + 60_000).toISOString()}`);
    expect(reason).toContain("earlier run");
    expect(reason).toContain(`delete ${lockFile(file)}`);
  });

  it("tells when a refused lock of another host is taken over, without suggesting to delete it", () => {
    const foreign = writeRecord({ host: "web-2", ttlMs: 30_000 });
    const err = thrownBy(() => take(file, { ttlMs: 30_000 }));
    const reason = err instanceof KestrelBootError ? err.reason : "";
    expect(reason).toContain(`taken over automatically from ${new Date(Date.parse(foreign.heartbeatAt) + 30_000).toISOString()}`);
    expect(reason).not.toContain("delete");
  });

  it("refuses a fresh lock that carries this process's pid from another pid namespace on this host", () => {
    writeRecord({ ...onThisHost, pid: process.pid, pidNamespace: FOREIGN_PID_NAMESPACE, startedAt: beforeThisProcess() });
    expect(thrownBy(() => take(file))).toBeInstanceOf(KestrelBootError);
  });

  it("takes over a lock from another pid namespace on this host once its heartbeat is older than the TTL", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ ...onThisHost, pid: process.pid, pidNamespace: FOREIGN_PID_NAMESPACE, startedAt: stale, heartbeatAt: stale });
    take(file);
    expect(readRecord().pidNamespace).toBe(ownPidNamespace());
  });

  it("shares the lock with a worker thread of this process, and neither reports a takeover", async () => {
    const main = take(file, { heartbeatMs: 25 });
    const script = join(dir, `worker-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        "import { parentPort, workerData } from \"node:worker_threads\";",
        `const { acquireInstanceLock } = await import(${JSON.stringify(LOCK_MODULE)});`,
        "const lock = acquireInstanceLock(workerData, { module: \"store/sqlite\", heartbeatMs: 25 });",
        "setTimeout(() => {",
        "  parentPort.postMessage(lock.health());",
        "  lock.release();",
        "}, 200);",
      ].join("\n"),
    );
    const worker = new Worker(script, { workerData: file });
    const workerHealth = await new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workerHealth).toEqual({ ok: true });
    expect(main.health()).toEqual({ ok: true });
    expect(readRecord().pid).toBe(process.pid);
  });

  it("refuses an unreadable lock file that was written within the TTL", () => {
    writeFileSync(lockFile(file), "");
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain("unreadable");
  });

  it("takes over an unreadable lock file older than the TTL", () => {
    writeFileSync(lockFile(file), "{");
    const past = new Date(Date.now() - 120_000);
    utimesSync(lockFile(file), past, past);
    take(file);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("waits for the takeover marker of a process on another host until it has expired, and then takes over a stale lock", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ startedAt: stale, heartbeatAt: stale });
    const guard = writeGuard({ pid: 4242, host: "web-2", bootId: randomUUID() }, 4_500);
    const began = performance.now();
    take(file);
    expect(performance.now() - began).toBeGreaterThanOrEqual(300);
    expect(readRecord().pid).toBe(process.pid);
    expect(existsSync(guard)).toBe(false);
  });

  it("never clears the takeover marker of a live process on this host by its age, and refuses naming that process", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    const foreign = writeRecord({ startedAt: stale, heartbeatAt: stale });
    const guard = writeGuard({ pid: process.ppid, processStart: startOf(process.ppid) }, 60_000);
    const err = thrownBy(() => take(file));
    expect(err instanceof KestrelBootError ? err.code : err).toBe("instance-locked");
    const reason = err instanceof KestrelBootError ? err.reason : "";
    expect(reason).toContain(`pid ${process.ppid}`);
    expect(reason).toContain(guard);
    expect(readRecord()).toEqual(foreign);
    expect(existsSync(guard)).toBe(true);
  }, 20_000);

  it("clears at once a takeover marker that a process on this host left behind when it died", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ startedAt: stale, heartbeatAt: stale });
    const guard = writeGuard({ pid: deadPid() });
    const began = performance.now();
    take(file);
    expect(performance.now() - began).toBeLessThan(1_000);
    expect(readRecord().pid).toBe(process.pid);
    expect(existsSync(guard)).toBe(false);
  });

  it("removes its lock file on release although a process on this host died holding the takeover marker", () => {
    const lock = take(file);
    const guard = writeGuard({ pid: deadPid() });
    lock.release();
    expect(existsSync(lockFile(file))).toBe(false);
    expect(existsSync(guard)).toBe(false);
  });

  it("clears a takeover marker left behind by a process that died while taking over", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ startedAt: stale, heartbeatAt: stale });
    const marker = `${lockFile(file)}.takeover`;
    writeFileSync(marker, randomUUID());
    const past = new Date(Date.now() - 120_000);
    utimesSync(marker, past, past);
    take(file);
    expect(readRecord().pid).toBe(process.pid);
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps its heartbeat fresh, so a long-running holder is never taken over", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const lock = take(file);
    vi.advanceTimersByTime(300_000);
    expect(readRecord().heartbeatAt).toBe("2026-03-01T10:05:00.000Z");
    expect(lock.health()).toEqual({ ok: true });
  });

  it("reports a lock taken over by another instance as not ok and restart required", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lock = take(file);
    const other = take(file);
    const foreign = writeRecord({ host: "web-2", pid: 311 });
    expect(lock.health()).toEqual({ ok: true });
    vi.advanceTimersByTime(10_000);
    const health = lock.health();
    expect(health).toMatchObject({ ok: false, restartRequired: true });
    expect(health.ok ? "" : health.reason).toContain('"web-2"');
    expect(other.health()).toEqual(health);
    expect(readRecord()).toEqual(foreign);
    lock.release();
    other.release();
    expect(readRecord()).toEqual(foreign);
  });

  it("refuses a fresh foreign lock after this process lost the lock, instead of handing out the lost share", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lost = take(file);
    writeRecord({ host: "web-2", pid: 311 });
    vi.advanceTimersByTime(10_000);
    expect(lost.health().ok).toBe(false);
    const err = thrownBy(() => take(file));
    expect(err instanceof KestrelBootError ? err.code : err).toBe("instance-locked");
    expect(readRecord().host).toBe("web-2");
  });

  it("takes the lock anew after losing it once the foreign lock has expired, and the lost share's release leaves the new one alone", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    const lost = take(file);
    writeRecord({ host: "web-2", pid: 311 });
    vi.advanceTimersByTime(10_000);
    expect(lost.health().ok).toBe(false);
    vi.advanceTimersByTime(60_000);
    const renewed = take(file);
    const id = readRecord().instanceId;
    expect(readRecord().pid).toBe(process.pid);
    expect(renewed.health()).toEqual({ ok: true });
    lost.release();
    const joined = take(file);
    expect(readRecord().instanceId).toBe(id);
    renewed.release();
    expect(existsSync(lockFile(file))).toBe(true);
    joined.release();
    expect(existsSync(lockFile(file))).toBe(false);
  });

  it("recreates its sidecar when the file disappears while it holds the lock", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lock = take(file);
    const id = readRecord().instanceId;
    rmSync(lockFile(file));
    vi.advanceTimersByTime(10_000);
    expect(readRecord().instanceId).toBe(id);
    expect(lock.health()).toEqual({ ok: true });
  });

  it("does not throw from release() when the lock file cannot be removed", () => {
    const lock = take(file);
    chmodSync(dir, 0o555);
    try {
      expect(() => lock.release()).not.toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it("removes leftovers of earlier attempts older than the TTL once it holds the lock, and keeps younger ones and unrelated files", () => {
    const lockPath = lockFile(file);
    const old = [`${lockPath}.${randomUUID()}.tmp`, `${lockPath}.${randomUUID()}.stale`, `${lockPath}.takeover.${randomUUID()}.tmp`];
    const kept = [`${lockPath}.${randomUUID()}.tmp`, `${lockPath}.notes`, join(dir, `other.db.instance.${randomUUID()}.tmp`)];
    const past = new Date(Date.now() - 120_000);
    for (const path of [...old, ...kept]) writeFileSync(path, "");
    for (const path of [...old, ...kept.slice(1)]) utimesSync(path, past, past);
    take(file);
    expect(old.filter((path) => existsSync(path))).toEqual([]);
    expect(kept.filter((path) => existsSync(path))).toEqual(kept);
  });

  it("runs the heartbeat on an unref'd timer and stops it on the last release", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const first = take(file);
    const second = take(file);
    expect(setSpy).toHaveBeenCalledTimes(1);
    const timer: unknown = setSpy.mock.results[0]?.value;
    if (!isRefCounted(timer)) throw new Error("setInterval returned no timer object");
    expect(timer.hasRef()).toBe(false);
    first.release();
    expect(clearSpy).not.toHaveBeenCalled();
    second.release();
    expect(clearSpy).toHaveBeenCalledWith(timer);
  });

  it("leaves no timer behind once released", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lock = take(file);
    expect(vi.getTimerCount()).toBe(1);
    lock.release();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("acquireInstanceLock across processes", () => {
  function childScript(): string {
    const script = join(dir, `holder-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        `import { acquireInstanceLock } from ${JSON.stringify(LOCK_MODULE)};`,
        "const [file, startAt, options = \"{}\"] = process.argv.slice(2);",
        "const idle = Number(startAt) - Date.now() - 30;",
        "if (idle > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, idle);",
        "while (Date.now() < Number(startAt)) {}",
        "let line;",
        "try {",
        "  acquireInstanceLock(file, { module: \"store/sqlite\", ...JSON.parse(options) });",
        "  line = \"won\";",
        "} catch (err) {",
        "  line = `lost:${err.code}`;",
        "}",
        "process.stdout.write(line + \"\\n\");",
        "process.stdin.resume();",
        "process.stdin.on(\"end\", () => process.exit(0));",
      ].join("\n"),
    );
    return script;
  }

  function stallingScript(go: string): string {
    const script = join(dir, `staller-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        "import fs from \"node:fs\";",
        "import { syncBuiltinESMExports } from \"node:module\";",
        `const go = ${JSON.stringify(go)};`,
        "const [file] = process.argv.slice(2);",
        "const lockPath = `${file}.instance`;",
        "const rename = fs.renameSync;",
        "const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);",
        "let stalled = false;",
        "fs.renameSync = function (from, to) {",
        "  if (stalled || (from !== lockPath && to !== lockPath)) return rename(from, to);",
        "  stalled = true;",
        "  process.stdout.write(\"ready\\n\");",
        "  while (!fs.existsSync(go)) wait(5);",
        "  rename(from, to);",
        "  process.stdout.write(\"renamed\\n\");",
        "  wait(500);",
        "};",
        "syncBuiltinESMExports();",
        `const { acquireInstanceLock } = await import(${JSON.stringify(LOCK_MODULE)});`,
        "let line;",
        "try {",
        "  acquireInstanceLock(file, { module: \"store/sqlite\" });",
        "  line = \"won\";",
        "} catch (err) {",
        "  line = `lost:${err.code}`;",
        "}",
        "process.stdout.write(line + \"\\n\");",
        "process.stdin.resume();",
        "process.stdin.on(\"end\", () => process.exit(0));",
      ].join("\n"),
    );
    return script;
  }

  interface Racer {
    child: ChildProcess;
    line: Promise<string>;
    said(text: string): Promise<void>;
  }

  function start(script: string, startAt: number, command: string[] = [process.execPath], extra: string[] = []): Racer {
    const [program = process.execPath, ...prefix] = command;
    const child = spawn(program, [...prefix, "--disable-warning=ExperimentalWarning", script, file, String(startAt), ...extra], { stdio: ["pipe", "pipe", "inherit"] });
    children.push(child);
    let out = "";
    const waiting: { text: string; resolve: () => void }[] = [];
    const outcome = /^(won|lost:.*)$/m;
    const line = new Promise<string>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        for (const w of waiting.splice(0)) {
          if (out.split("\n").includes(w.text)) w.resolve();
          else waiting.push(w);
        }
        const found = outcome.exec(out);
        if (found !== null) resolve(found[1] ?? "");
      });
      child.on("exit", (code, signal) => reject(new Error(`child exited with ${String(code ?? signal)} before reporting`)));
    });
    line.catch(() => undefined);
    const said = (text: string): Promise<void> =>
      new Promise((resolve) => {
        if (out.split("\n").includes(text)) resolve();
        else waiting.push({ text, resolve });
      });
    return { child, line, said };
  }

  function exited(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }

  it("is shared by two copies of the module loaded into one process", () => {
    const script = join(dir, `copies-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        `const a = await import(${JSON.stringify(`${LOCK_MODULE}?copy=a`)});`,
        `const b = await import(${JSON.stringify(`${LOCK_MODULE}?copy=b`)});`,
        "import { existsSync } from \"node:fs\";",
        "const [file] = process.argv.slice(2);",
        "const first = a.acquireInstanceLock(file, { module: \"store/sqlite\", heartbeatMs: 25 });",
        "const second = b.acquireInstanceLock(file, { module: \"store/sqlite\", heartbeatMs: 25 });",
        "setTimeout(() => {",
        "  const health = [first.health(), second.health()];",
        "  first.release();",
        "  const afterFirst = existsSync(a.instanceLockFile(file));",
        "  second.release();",
        "  const afterSecond = existsSync(a.instanceLockFile(file));",
        "  process.stdout.write(JSON.stringify({ health, afterFirst, afterSecond }));",
        "}, 200);",
      ].join("\n"),
    );
    const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script, file], { encoding: "utf8", timeout: 15_000 });
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toEqual({ health: [{ ok: true }, { ok: true }], afterFirst: true, afterSecond: false });
  });

  it("keeps another process off while a worker thread still holds the lock that the main thread released", async () => {
    const main = take(file);
    const script = join(dir, `worker-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        "import { parentPort, workerData } from \"node:worker_threads\";",
        `const { acquireInstanceLock } = await import(${JSON.stringify(LOCK_MODULE)});`,
        "const lock = acquireInstanceLock(workerData, { module: \"store/sqlite\" });",
        "parentPort.postMessage(\"held\");",
        "parentPort.once(\"message\", () => {",
        "  const health = lock.health();",
        "  lock.release();",
        "  parentPort.postMessage(health);",
        "});",
      ].join("\n"),
    );
    const worker = new Worker(script, { workerData: file });
    const next = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    try {
      expect(await next()).toBe("held");
      main.release();
      expect(existsSync(lockFile(file))).toBe(true);
      const other = start(childScript(), 0);
      expect(await other.line).toBe("lost:instance-locked");
      other.child.stdin?.end();
      const workerHealth = next();
      worker.postMessage("release");
      expect(await workerHealth).toEqual({ ok: true });
      expect(existsSync(lockFile(file))).toBe(false);
    } finally {
      await worker.terminate();
    }
  }, 20_000);

  it("lets a new process take the lock at once after the holder was killed with SIGKILL", async () => {
    const holder = start(childScript(), 0);
    expect(await holder.line).toBe("won");
    expect(readRecord().pid).toBe(holder.child.pid);

    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain(String(holder.child.pid));

    holder.child.kill("SIGKILL");
    await exited(holder.child);
    expect(existsSync(lockFile(file))).toBe(true);

    take(file);
    expect(readRecord().pid).toBe(process.pid);
  }, 20_000);

  it("keeps another process with a shorter TTL off a live holder whose heartbeat is older than that TTL", async () => {
    const holder = start(childScript(), 0, [process.execPath], [JSON.stringify({ ttlMs: 3_000, heartbeatMs: 1_000 })]);
    expect(await holder.line).toBe("won");
    for (let tries = 0; tries < 3; tries++) {
      while (Date.now() - Date.parse(readRecord().heartbeatAt) < 400) await new Promise((resolve) => setTimeout(resolve, 20));
      const err = thrownBy(() => take(file, { ttlMs: 300, heartbeatMs: 100 }));
      expect(err instanceof KestrelBootError ? err.code : err).toBe("instance-locked");
      expect(readRecord().pid).toBe(holder.child.pid);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 20_000);

  function endingScript(ending: string): string {
    const script = join(dir, `ending-${randomUUID()}.mjs`);
    writeFileSync(
      script,
      [
        `import { acquireInstanceLock } from ${JSON.stringify(LOCK_MODULE)};`,
        "const [file] = process.argv.slice(2);",
        "acquireInstanceLock(file, { module: \"store/sqlite\" });",
        "acquireInstanceLock(file, { module: \"store/sqlite\" });",
        ending,
      ].join("\n"),
    );
    return script;
  }

  it("removes its lock file when the process ends through process.exit() or an uncaught exception without releasing", () => {
    for (const ending of ["process.exit(3);", "setTimeout(() => { throw new Error(\"boom\"); }, 10);"]) {
      const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", endingScript(ending), file], { encoding: "utf8", timeout: 15_000 });
      expect(run.status).not.toBe(0);
      expect(existsSync(lockFile(file))).toBe(false);
    }
  }, 20_000);

  async function race(prepare: () => void, count = 2): Promise<{ lines: string[]; record: LockRecord }> {
    prepare();
    const script = childScript();
    const startAt = Date.now() + 800;
    const racers = Array.from({ length: count }, () => start(script, startAt));
    const lines = await Promise.all(racers.map((r) => r.line));
    const record = readRecord();
    for (const r of racers) r.child.stdin?.end();
    await Promise.all(racers.map((r) => exited(r.child)));
    return { lines: lines.sort(), record };
  }

  it("lets exactly one of two processes win the race for a free lock", async () => {
    for (let round = 0; round < 3; round++) {
      expect((await race(() => rmSync(lockFile(file), { force: true }))).lines).toEqual(["lost:instance-locked", "won"]);
    }
  }, 30_000);

  it("lets exactly one of two processes win the race to take over a stale lock", async () => {
    for (let round = 0; round < 3; round++) {
      const stale = new Date(Date.now() - 120_000).toISOString();
      expect((await race(() => writeRecord({ startedAt: stale, heartbeatAt: stale }))).lines).toEqual(["lost:instance-locked", "won"]);
    }
  }, 30_000);

  it("lets exactly one of four processes win the race to take over a stale lock, and leaves the winner's record behind", async () => {
    for (let round = 0; round < 8; round++) {
      const stale = new Date(Date.now() - 120_000).toISOString();
      const { lines, record } = await race(() => writeRecord({ startedAt: stale, heartbeatAt: stale }), 4);
      expect(lines).toEqual(["lost:instance-locked", "lost:instance-locked", "lost:instance-locked", "won"]);
      expect(record.heartbeatAt).not.toBe(stale);
      expect(existsSync(lockFile(file))).toBe(false);
    }
  }, 60_000);

  it("lets exactly one of three processes win when one of them stalls in the middle of taking over a stale lock", async () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ startedAt: stale, heartbeatAt: stale });
    const go = join(dir, "go");
    const staller = start(stallingScript(go), 0);
    await staller.said("ready");
    const first = start(childScript(), 0);
    const firstLine = await first.line;
    writeFileSync(go, "");
    await staller.said("renamed");
    const late = start(childScript(), 0);
    const lines = [firstLine, await staller.line, await late.line];
    expect(lines.filter((line) => line === "won")).toHaveLength(1);
  }, 30_000);

  it("leaves the lock free when a process cannot finish writing it", async () => {
    const failing = start(childScript(), 0, ["/bin/sh", "-c", 'ulimit -f 0; exec "$0" "$@"', process.execPath]);
    expect(await failing.line.catch(() => "died")).not.toBe("won");
    take(file);
    expect(readRecord().pid).toBe(process.pid);
  }, 20_000);
});
