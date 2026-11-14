import { spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join, resolve } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { REPLICATION_PACKAGE } from "./context.ts";
import { OpsError } from "./errors.ts";
import { packageDir, packageVersion } from "./packages.ts";

/** What a target reports about the app it runs. */
export interface TargetStatus {
  state: "started" | "stopped" | "unknown";
  /** Running instances; a promotion needs 0. */
  instances: number;
}

/** Facts about a target recorded in every backup manifest. */
export interface TargetFacts {
  kind: string;
  /** Installed versions of the app's packages by name, as far as the target can tell. */
  packages: Record<string, string>;
  [fact: string]: unknown;
}

/**
 * The platform an app runs on. A target with `transport: "promote"` starts on an empty disk and restores the newest
 * replica generation (an ephemeral container); one with `transport: "file"` keeps its disk and takes a restored
 * database through {@link Target.installDatabase} while stopped.
 */
export interface Target {
  readonly transport: "promote" | "file";
  describe(): Promise<TargetFacts>;
  status(): Promise<TargetStatus>;
  /** Stops the app and resolves once it reports stopped, with the time it stopped. */
  stop(): Promise<{ stoppedAt: number }>;
  start(): Promise<void>;
  /** Waits until the app answers its readiness check; false after `timeoutMs`. */
  waitReady(timeoutMs: number): Promise<boolean>;
  /** Places a restored database for the next start; only for `transport: "file"`. */
  installDatabase?(file: string): Promise<void>;
  /** Evidence for a stop without a seal, shown next to the question whether to go on. */
  stopEvidence?(): Promise<string[]>;
}

/** What a target factory gets besides its own configuration. */
export interface TargetDeps {
  /** The directory `kestrel.environments.json` lives in. */
  root: string;
  clock: () => number;
}

/** Builds a target from its `target` block in `kestrel.environments.json`. */
export type TargetFactory = (config: Record<string, unknown>, deps: TargetDeps) => Target | Promise<Target>;

/** `target` of an environment that runs on this machine. */
export interface LocalTargetConfig {
  /** The app's directory, relative to the environments file. */
  dir: string;
  /** The database file, relative to `dir`. */
  database: string;
  /** The command that starts the app, run in `dir` without a shell. */
  command: string[];
  /** Environment variables of the app. The tool's own environment, credentials included, is never passed on. */
  env?: Record<string, string>;
  /** An http(s) URL that answers 200 once the app is ready. */
  readyUrl?: string;
  /** `ephemeral` removes the database before each start, so the app restores the newest replica generation. */
  disk: "ephemeral" | "persistent";
}

function parseLocal(config: Record<string, unknown>): LocalTargetConfig {
  const { dir, database, command, env, readyUrl, disk } = config;
  if (typeof dir !== "string" || typeof database !== "string") throw new OpsError("target local: dir and database are required", 2, "target");
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string")) throw new OpsError("target local: command must be a non-empty list of strings", 2, "target");
  if (disk !== "ephemeral" && disk !== "persistent") throw new OpsError('target local: disk must be "ephemeral" or "persistent"', 2, "target");
  const out: LocalTargetConfig = { dir, database, command: boundaryCast<string[]>(command, "json"), disk };
  if (env !== undefined) {
    if (typeof env !== "object" || env === null || !Object.values(env).every((v) => typeof v === "string")) throw new OpsError("target local: env must map names to strings", 2, "target");
    out.env = boundaryCast<Record<string, string>>(env, "json");
  }
  if (readyUrl !== undefined) {
    if (typeof readyUrl !== "string") throw new OpsError("target local: readyUrl must be a string", 2, "target");
    out.readyUrl = readyUrl;
  }
  return out;
}

type Liveness = "alive" | "gone" | "foreign";

const liveness = (pid: number): Liveness => {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (cause) {
    return cause instanceof Error && Reflect.get(cause, "code") === "EPERM" ? "foreign" : "gone";
  }
};

function startedAt(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    process.kill(pid, signal);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** The sidecar the instance lock keeps next to a database file. Backups never contain it and restores never write it. */
export function instanceLockSidecar(file: string): string {
  return `${file}.instance`;
}

const RUNTIME_PACKAGES = [REPLICATION_PACKAGE, "@michaelthielemann/kestrel"];

function installedPackages(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const manifestFile = join(dir, "package.json");
  if (!existsSync(manifestFile)) return out;
  const manifest = boundaryCast<{ dependencies?: Record<string, string> }>(JSON.parse(readFileSync(manifestFile, "utf8")), "json");
  const direct = Object.keys(manifest.dependencies ?? {});
  for (const name of direct) {
    const version = packageVersion(name, dir);
    if (version !== null) out[name] = version;
  }
  const from = [dir, ...direct.map((name) => packageDir(name, dir)).filter((d): d is string => d !== null)];
  for (const name of RUNTIME_PACKAGES) {
    if (out[name] !== undefined) continue;
    for (const base of from) {
      const version = packageVersion(name, base);
      if (version === null) continue;
      out[name] = version;
      break;
    }
  }
  return out;
}

/**
 * A target that runs the app as a background process group on this machine; its pid, with the process's start
 * time where the system tells it, lives in `.kestrel-ops.pid` in `dir`. A pid file older than the last boot, or
 * whose process started at another time, names no app; a pid that belongs to another user reads as `unknown` and is
 * never signalled.
 */
export const localTarget: TargetFactory = (raw, deps) => {
  const config = parseLocal(raw);
  const dir = resolve(deps.root, config.dir);
  const database = resolve(dir, config.database);
  const pidFile = join(dir, ".kestrel-ops.pid");
  const readPid = (): { pid: number; started: string | null } | null => {
    if (!existsSync(pidFile)) return null;
    if (statSync(pidFile).mtimeMs < Date.now() - uptime() * 1000) return null;
    const text = readFileSync(pidFile, "utf8").trim();
    let value: unknown = Number(text);
    try {
      if (text.startsWith("{")) value = JSON.parse(text);
    } catch {
      return null;
    }
    const pid: unknown = typeof value === "number" ? value : Reflect.get(Object(value), "pid");
    const started: unknown = typeof value === "number" ? null : Reflect.get(Object(value), "started");
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? { pid, started: typeof started === "string" ? started : null } : null;
  };
  const running = (): { pid: number; state: "alive" | "foreign" } | null => {
    const recorded = readPid();
    if (recorded === null) return null;
    const state = liveness(recorded.pid);
    if (state === "gone") return null;
    const now = startedAt(recorded.pid);
    if (recorded.started !== null && now !== null && now !== recorded.started) return null;
    return { pid: recorded.pid, state };
  };
  const target: Target = {
    transport: config.disk === "ephemeral" ? "promote" : "file",
    async describe() {
      return { kind: "local", packages: installedPackages(dir), dir: config.dir, database: config.database, disk: config.disk };
    },
    async status() {
      const app = running();
      return app === null ? { state: "stopped", instances: 0 } : { state: app.state === "alive" ? "started" : "unknown", instances: 1 };
    },
    async stop() {
      const app = running();
      if (app?.state === "foreign") throw new OpsError(`pid ${app.pid} in ${pidFile} belongs to another user; stop the app as that user`, 1, "target");
      if (app !== null) {
        signalGroup(app.pid, "SIGTERM");
        for (let waited = 0; liveness(app.pid) !== "gone"; waited += 100) {
          if (waited >= 60_000) throw new OpsError(`the app (pid ${app.pid}) did not stop within 60 s`, 1, "target");
          await sleep(100);
        }
      }
      rmSync(pidFile, { force: true });
      return { stoppedAt: deps.clock() };
    },
    async start() {
      if (running() !== null) throw new OpsError("the app is already running", 1, "target");
      if (config.disk === "ephemeral") for (const suffix of ["", "-wal", "-shm"]) rmSync(database + suffix, { force: true });
      const [file, ...args] = config.command;
      if (file === undefined) throw new OpsError("target local: empty command", 2, "target");
      const log = openSync(join(dir, ".kestrel-ops.log"), "a");
      try {
        const child = spawn(file, args, { cwd: dir, env: { PATH: process.env.PATH ?? "", ...config.env }, detached: true, stdio: ["ignore", log, log] });
        if (child.pid === undefined) throw new OpsError(`cannot start ${file}`, 1, "target");
        writeFileSync(pidFile, JSON.stringify({ pid: child.pid, started: startedAt(child.pid) }));
        child.unref();
      } finally {
        closeSync(log);
      }
    },
    async waitReady(timeoutMs) {
      const deadline = deps.clock() + timeoutMs;
      while (deps.clock() < deadline) {
        if (running() === null) return false;
        if (config.readyUrl === undefined) return true;
        try {
          if ((await fetch(config.readyUrl, { signal: AbortSignal.timeout(5000) })).status === 200) return true;
        } catch {
          await sleep(250);
          continue;
        }
        await sleep(250);
      }
      return false;
    },
    async installDatabase(file) {
      if (running() !== null) throw new OpsError("refusing to place a database while the app runs", 1, "target");
      mkdirSync(dirname(database), { recursive: true });
      copyFileSync(file, `${database}.restore`);
    },
    async stopEvidence() {
      return [`local app in ${config.dir}: stopped by the tool, no platform event log`];
    },
  };
  return target;
};
