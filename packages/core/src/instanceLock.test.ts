import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
  host: string;
  startedAt: string;
  heartbeatAt: string;
}

function ownPidNamespace(): string {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "";
  }
}

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

function readRecord(): LockRecord {
  const parsed: unknown = JSON.parse(readFileSync(instanceLockFile(file), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("lock file is not an object");
  return { ...{ instanceId: "", pid: 0, pidNamespace: "", host: "", startedAt: "", heartbeatAt: "" }, ...parsed };
}

function writeRecord(record: Partial<LockRecord>): LockRecord {
  const now = new Date().toISOString();
  const full: LockRecord = { instanceId: randomUUID(), pid: 4242, pidNamespace: ownPidNamespace(), host: "other-host", startedAt: now, heartbeatAt: now, ...record };
  writeFileSync(instanceLockFile(file), JSON.stringify(full));
  return full;
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
    expect(instanceLockFile(file)).toBe(`${file}.instance`);
  });

  it("names the same sidecar for every spelling of the same file", () => {
    expect(instanceLockFile(join(dir, ".", "sub", "..", "app.db"))).toBe(instanceLockFile(file));
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
    expect(existsSync(instanceLockFile(file))).toBe(true);
  });

  it("takes no lock and creates no file for an in-memory database", () => {
    const lock = take(":memory:");
    expect(existsSync(":memory:.instance")).toBe(false);
    expect(lock.health()).toEqual({ ok: true });
    lock.release();
  });

  it("is shared by several holders in one process, and the file disappears only with the last release", () => {
    const first = take(file);
    const second = take(join(dir, ".", "app.db"));
    const id = readRecord().instanceId;
    first.release();
    expect(existsSync(instanceLockFile(file))).toBe(true);
    expect(readRecord().instanceId).toBe(id);
    first.release();
    expect(existsSync(instanceLockFile(file))).toBe(true);
    second.release();
    expect(existsSync(instanceLockFile(file))).toBe(false);
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
    writeRecord({ host: hostname(), pid: process.ppid });
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

  it("honours a custom TTL", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
    writeRecord({});
    vi.setSystemTime(new Date("2026-03-01T10:00:06.000Z"));
    take(file, { ttlMs: 5_000, heartbeatMs: 1_000 });
    expect(readRecord().pid).toBe(process.pid);
  });

  it("takes over at once a lock of a dead process on the same host", () => {
    const foreign = writeRecord({ host: hostname(), pid: deadPid() });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("takes over at once a lock with this process's pid and pid namespace that was written before this process started", () => {
    const foreign = writeRecord({ host: hostname(), pid: process.pid, startedAt: beforeThisProcess() });
    take(file);
    expect(readRecord().instanceId).not.toBe(foreign.instanceId);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("shares a lock that another thread of this process holds instead of taking it over", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const sibling = writeRecord({ host: hostname(), pid: process.pid });
    const lock = take(file);
    expect(readRecord().instanceId).toBe(sibling.instanceId);
    vi.advanceTimersByTime(10_000);
    expect(lock.health()).toEqual({ ok: true });
    expect(readRecord().instanceId).toBe(sibling.instanceId);
  });

  it("refuses a fresh lock of a process on this host in another pid namespace, even when no process here has its pid", () => {
    writeRecord({ host: hostname(), pid: deadPid(), pidNamespace: FOREIGN_PID_NAMESPACE });
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.code : undefined).toBe("instance-locked");
  });

  it("refuses a fresh lock that carries this process's pid from another pid namespace on this host", () => {
    writeRecord({ host: hostname(), pid: process.pid, pidNamespace: FOREIGN_PID_NAMESPACE, startedAt: beforeThisProcess() });
    expect(thrownBy(() => take(file))).toBeInstanceOf(KestrelBootError);
  });

  it("takes over a lock from another pid namespace on this host once its heartbeat is older than the TTL", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ host: hostname(), pid: process.pid, pidNamespace: FOREIGN_PID_NAMESPACE, startedAt: stale, heartbeatAt: stale });
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
    writeFileSync(instanceLockFile(file), "");
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain("unreadable");
  });

  it("takes over an unreadable lock file older than the TTL", () => {
    writeFileSync(instanceLockFile(file), "{");
    const past = new Date(Date.now() - 120_000);
    utimesSync(instanceLockFile(file), past, past);
    take(file);
    expect(readRecord().pid).toBe(process.pid);
  });

  it("leaves a stale lock alone while another process is in the middle of taking it over", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    const foreign = writeRecord({ startedAt: stale, heartbeatAt: stale });
    writeFileSync(`${instanceLockFile(file)}.takeover`, randomUUID());
    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.code : undefined).toBe("instance-locked");
    expect(readRecord()).toEqual(foreign);
  });

  it("clears a takeover marker left behind by a process that died while taking over", () => {
    const stale = new Date(Date.now() - 120_000).toISOString();
    writeRecord({ startedAt: stale, heartbeatAt: stale });
    const marker = `${instanceLockFile(file)}.takeover`;
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

  it("recreates its sidecar when the file disappears while it holds the lock", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lock = take(file);
    const id = readRecord().instanceId;
    rmSync(instanceLockFile(file));
    vi.advanceTimersByTime(10_000);
    expect(readRecord().instanceId).toBe(id);
    expect(lock.health()).toEqual({ ok: true });
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
        "const [file, startAt] = process.argv.slice(2);",
        "while (Date.now() < Number(startAt)) {}",
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

  function start(script: string, startAt: number, command: string[] = [process.execPath]): Racer {
    const [program = process.execPath, ...prefix] = command;
    const child = spawn(program, [...prefix, "--disable-warning=ExperimentalWarning", script, file, String(startAt)], { stdio: ["pipe", "pipe", "inherit"] });
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

  it("lets a new process take the lock at once after the holder was killed with SIGKILL", async () => {
    const holder = start(childScript(), 0);
    expect(await holder.line).toBe("won");
    expect(readRecord().pid).toBe(holder.child.pid);

    const err = thrownBy(() => take(file));
    expect(err).toBeInstanceOf(KestrelBootError);
    expect(err instanceof KestrelBootError ? err.reason : "").toContain(String(holder.child.pid));

    holder.child.kill("SIGKILL");
    await exited(holder.child);
    expect(existsSync(instanceLockFile(file))).toBe(true);

    take(file);
    expect(readRecord().pid).toBe(process.pid);
  }, 20_000);

  async function race(prepare: () => void, count = 2): Promise<string[]> {
    prepare();
    const script = childScript();
    const startAt = Date.now() + 800;
    const racers = Array.from({ length: count }, () => start(script, startAt));
    const lines = await Promise.all(racers.map((r) => r.line));
    for (const r of racers) r.child.stdin?.end();
    await Promise.all(racers.map((r) => exited(r.child)));
    return lines.sort();
  }

  it("lets exactly one of two processes win the race for a free lock", async () => {
    for (let round = 0; round < 3; round++) {
      expect(await race(() => rmSync(instanceLockFile(file), { force: true }))).toEqual(["lost:instance-locked", "won"]);
    }
  }, 30_000);

  it("lets exactly one of two processes win the race to take over a stale lock", async () => {
    for (let round = 0; round < 3; round++) {
      const stale = new Date(Date.now() - 120_000).toISOString();
      expect(await race(() => writeRecord({ startedAt: stale, heartbeatAt: stale }))).toEqual(["lost:instance-locked", "won"]);
    }
  }, 30_000);

  it("lets exactly one of four processes win the race to take over a stale lock, and leaves the winner's record behind", async () => {
    for (let round = 0; round < 8; round++) {
      const stale = new Date(Date.now() - 120_000).toISOString();
      const lines = await race(() => writeRecord({ startedAt: stale, heartbeatAt: stale }), 4);
      expect(lines).toEqual(["lost:instance-locked", "lost:instance-locked", "lost:instance-locked", "won"]);
      expect(readRecord().heartbeatAt).not.toBe(stale);
      rmSync(instanceLockFile(file), { force: true });
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
