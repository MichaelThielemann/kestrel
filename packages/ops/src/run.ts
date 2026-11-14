import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createBackup, listBackups, prune, unpin, verifyBackup } from "./backup.ts";
import { messageOf, type OpsContext } from "./context.ts";
import { resolveCredential, type CommandRunner } from "./credentials.ts";
import { ENVIRONMENTS_FILE, environmentProblems, loadEnvironments, type Environment, type StorageConfig } from "./environments.ts";
import { OpsError } from "./errors.ts";
import { Journal } from "./journal.ts";
import { Interrupt, interruptible, type SignalSource } from "./interrupt.ts";
import { hex, parseBackupId, parseJson, type BackupKind } from "./layout.ts";
import { acquireLock, breakLocks, type Lock } from "./lock.ts";
import { createOutput } from "./output.ts";
import type { Prompt } from "./questions.ts";
import { Redactor } from "./redact.ts";
import type { PollOptions } from "./replica.ts";
import { restoreBackup, restoreToLocal } from "./restore.ts";
import { s3Store } from "./s3Store.ts";
import { sha256File } from "./sqlite.ts";
import { status } from "./status.ts";
import type { ObjectStore } from "./store.ts";
import { localTarget, type TargetFactory } from "./target.ts";
import { createWorkspace, stateDir } from "./workspace.ts";

/** Builds an object store from a storage block with resolved credentials; tests replace it. */
export type StoreFactory = (config: StorageConfig, credentials: { accessKeyId: string; secretAccessKey: string } | null, role: "tool" | "app") => ObjectStore;

/** What {@link runOps} needs from its host; everything but the streams has a default. */
export interface RunOptions {
  /** The project root holding `kestrel.environments.json`. Default: the working directory. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Interactive prompt; without one every question needs `--yes` or `--answers`. */
  prompt?: Prompt;
  /** Target adapters by name, besides the built-in `local`. */
  targets?: Record<string, TargetFactory>;
  stores?: StoreFactory;
  clock?: () => number;
  /** Root of the local working directories. Default: the per-user state directory. */
  stateRoot?: string;
  poll?: PollOptions;
  readyTimeoutMs?: number;
  runCommand?: CommandRunner;
  /** Package versions and lockfile hash to record instead of reading them from the project, as a bundle does. */
  project?: { versions: Record<string, string>; lockfileSha256: string | null };
  /** Where SIGINT and SIGTERM arrive while a writing command runs. Default: `process`. */
  signals?: SignalSource;
}

/** The usage text of the commands {@link runOps} understands. */
export const USAGE = `usage:
  status                          [--env <name>]
  backup create [--freeze] [--kind manual|scheduled|cutover]
  backup list
  backup verify <id>
  backup prune [--dry-run]
  restore --backup <id> [--no-safety-backup]
  restore --to local <dir> (--backup <id> | --latest) [--with-media] [--keep-sessions]
common options: --env <name>, --json, --yes, --answers <file>, --keep (keep the local working directory),
  --break-lock (release the lock of a run that ended without releasing it)
exit codes: 0 done, 1 a check failed or a step was refused, 2 usage or configuration error`;

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["--env", "--kind", "--backup", "--to", "--answers"]);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) positional.push(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new OpsError(`${arg} needs a value`, 2, arg);
      flags.set(arg, value);
      i += 1;
    } else flags.set(arg, true);
  }
  return { positional, flags };
}

const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--freeze", "--dry-run", "--no-safety-backup", "--latest", "--with-media", "--keep-sessions", "--json", "--yes", "--keep", "--break-lock"]);

type Command =
  | { name: "status" }
  | { name: "backup-create"; kind: BackupKind; freeze: boolean }
  | { name: "backup-list" }
  | { name: "backup-verify"; id: string }
  | { name: "backup-prune"; dryRun: boolean }
  | { name: "restore"; backupId: string; noSafetyBackup: boolean }
  | { name: "restore-local"; dir: string; backupId: string | null; withMedia: boolean; keepSessions: boolean };

const COMMON_FLAGS = ["--env", "--json", "--yes", "--answers", "--keep", "--break-lock"];

const COMMANDS: Record<Command["name"], { label: string; flags: string[] }> = {
  status: { label: "status", flags: [] },
  "backup-create": { label: "backup create", flags: ["--freeze", "--kind"] },
  "backup-list": { label: "backup list", flags: [] },
  "backup-verify": { label: "backup verify", flags: [] },
  "backup-prune": { label: "backup prune", flags: ["--dry-run"] },
  restore: { label: "restore --backup", flags: ["--backup", "--no-safety-backup"] },
  "restore-local": { label: "restore --to local", flags: ["--to", "--backup", "--latest", "--with-media", "--keep-sessions"] },
};

const usage = (message: string, element?: string): OpsError => new OpsError(message, 2, element);

function backupIdArgument(id: string, element: string): string {
  if (parseBackupId(id) === null) throw usage(`${id} is not a backup id (<env>-<yyyymmddThhmmssZ>-<kind>-<4 hex>)`, element);
  return id;
}

function commandName(parsed: Parsed): Command["name"] {
  const [command, sub] = parsed.positional;
  if (command === "status") return "status";
  if (command === "backup" && (sub === "create" || sub === "list" || sub === "verify" || sub === "prune")) return `backup-${sub}`;
  if (command === "restore") return parsed.flags.has("--to") ? "restore-local" : "restore";
  throw usage(command === undefined ? "no command given" : `unknown command ${parsed.positional.slice(0, 2).join(" ")}`);
}

function readCommand(parsed: Parsed): Command {
  const unknown = [...parsed.flags.keys()].filter((f) => !KNOWN_FLAGS.has(f));
  if (unknown.length > 0) throw usage(`unknown option ${unknown.join(", ")}`, unknown[0]);
  const name = commandName(parsed);
  const { label, flags } = COMMANDS[name];
  const allowed = new Set([...COMMON_FLAGS, ...flags]);
  const foreign = [...parsed.flags.keys()].filter((f) => !allowed.has(f));
  if (foreign.length > 0) throw usage(`${label} does not take ${foreign.join(", ")}`, foreign[0]);
  const [, sub, ...rest] = parsed.positional;
  const operands = name === "status" || name === "restore" ? parsed.positional.slice(1) : rest;
  const expected = name === "backup-verify" ? 1 : 0;
  if (name !== "restore-local" && operands.length !== expected) throw usage(expected === 1 ? "backup verify needs one backup id" : `${label} takes no argument ${operands.join(" ")}`);
  const backup = value(parsed, "--backup");
  switch (name) {
    case "backup-create": {
      const kind = value(parsed, "--kind") ?? "manual";
      if (kind !== "manual" && kind !== "scheduled" && kind !== "cutover") throw usage("--kind must be manual, scheduled or cutover", "--kind");
      return { name, kind, freeze: parsed.flags.has("--freeze") };
    }
    case "backup-verify":
      return { name, id: backupIdArgument(operands[0] ?? "", "backup verify") };
    case "backup-prune":
      return { name, dryRun: parsed.flags.has("--dry-run") };
    case "restore":
      if (backup === null) throw usage("restore needs --backup <id> or --to local <dir>", "--backup");
      return { name, backupId: backupIdArgument(backup, "--backup"), noSafetyBackup: parsed.flags.has("--no-safety-backup") };
    case "restore-local": {
      if (value(parsed, "--to") !== "local") throw usage("--to takes local <dir>", "--to");
      if (sub === undefined || rest.length > 0) throw usage("restore --to local needs one directory", "--to");
      const latest = parsed.flags.has("--latest");
      if ((backup === null) === !latest) throw usage("restore --to local needs --backup <id> or --latest", "--backup");
      const withMedia = parsed.flags.has("--with-media");
      if (backup === null && withMedia) throw usage("--with-media needs --backup <id>", "--with-media");
      return { name, dir: sub, backupId: backup === null ? null : backupIdArgument(backup, "--backup"), withMedia, keepSessions: parsed.flags.has("--keep-sessions") };
    }
    default:
      return { name };
  }
}

function value(parsed: Parsed, flag: string): string | null {
  const v = parsed.flags.get(flag);
  return typeof v === "string" ? v : null;
}

function toolVersion(): string {
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
  return boundaryCast<{ version: string }>(JSON.parse(readFileSync(manifest, "utf8")), "json").version;
}

function projectFacts(root: string): { versions: Record<string, string>; lockfileSha256: string | null } {
  const versions: Record<string, string> = {};
  const manifest = join(root, "package.json");
  if (existsSync(manifest)) {
    const pkg = boundaryCast<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(JSON.parse(readFileSync(manifest, "utf8")), "json");
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const installed = join(root, "node_modules", name, "package.json");
      if (!existsSync(installed)) continue;
      const version = boundaryCast<{ version?: unknown }>(JSON.parse(readFileSync(installed, "utf8")), "json").version;
      if (typeof version === "string") versions[name] = version;
    }
  }
  const lock = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"].map((f) => join(root, f)).find((f) => existsSync(f));
  return { versions, lockfileSha256: lock === undefined ? null : sha256File(lock) };
}

const defaultStores: StoreFactory = (config, credentials) =>
  s3Store({ bucket: config.bucket, prefix: config.prefix, region: config.region, endpoint: config.endpoint, forcePathStyle: config.forcePathStyle, requestChecksumCalculation: config.requestChecksumCalculation, accessKeyId: credentials?.accessKeyId, secretAccessKey: credentials?.secretAccessKey });

async function credentialsOf(config: StorageConfig["credentials"], label: string, redactor: Redactor, env: NodeJS.ProcessEnv, run: CommandRunner | undefined): Promise<{ accessKeyId: string; secretAccessKey: string } | null> {
  if (config === undefined) return null;
  return {
    accessKeyId: await resolveCredential(config.accessKeyId, `${label}.accessKeyId`, redactor, env, run),
    secretAccessKey: await resolveCredential(config.secretAccessKey, `${label}.secretAccessKey`, redactor, env, run),
  };
}

async function loadTarget(env: Environment, options: RunOptions, root: string, clock: () => number) {
  const { adapter, ...config } = env.target;
  const factory = options.targets?.[adapter] ?? (adapter === "local" ? localTarget : null);
  if (factory) return factory(config, { root, clock });
  let mod: unknown;
  try {
    mod = await import(adapter);
  } catch {
    throw new OpsError(`target adapter ${adapter} is not installed`, 2, "target");
  }
  const create: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "createTarget") : undefined;
  if (typeof create !== "function") throw new OpsError(`target adapter ${adapter} exports no createTarget`, 2, "target");
  return boundaryCast<TargetFactory>(create, "host")(config, { root, clock });
}

function readAnswers(file: string | null): Record<string, string> {
  if (file === null) return {};
  let value: unknown;
  try {
    value = parseJson(new Uint8Array(readFileSync(resolve(file))));
  } catch (cause) {
    throw new OpsError(`${file}: cannot read the answers file: ${cause instanceof Error ? cause.message : String(cause)}`, 2, "--answers");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.values(value).every((v) => typeof v === "string")) throw new OpsError(`${file}: answers must map question ids to strings`, 2, "--answers");
  return boundaryCast<Record<string, string>>(value, "json");
}

/** A prompt on the terminal, or undefined when stdin is not one. Ctrl-C at the prompt sends the process SIGINT; `signal` ends a pending question. */
export function terminalPrompt(signal?: AbortSignal): Prompt | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.on("SIGINT", () => process.kill(process.pid, "SIGINT"));
    try {
      return await rl.question(question, signal ? { signal } : {});
    } finally {
      rl.close();
    }
  };
}

/** Runs one command line of `status`, `backup` or `restore` and returns its exit code. */
export async function runOps(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const redactor = new Redactor();
  const stdout = options.stdout ?? ((t: string) => process.stdout.write(t));
  const stderr = options.stderr ?? ((t: string) => process.stderr.write(t));
  const json = argv.includes("--json");
  const out = createOutput(redactor, stdout, stderr, json);
  const emit = (name: string, payload: Record<string, unknown>): void => {
    if (json) stdout(redactor.json({ schema: `kestrel-ops/${name}@1`, ...payload }, 2) + "\n");
  };
  let cmd: Command;
  let parsed: Parsed;
  try {
    parsed = parse(argv);
    cmd = readCommand(parsed);
  } catch (error) {
    const message = messageOf(error);
    stderr(`error: ${message}\n${USAGE}\n`);
    emit("error", { ok: false, message, element: error instanceof OpsError ? (error.element ?? null) : null });
    return 2;
  }
  const clock = options.clock ?? Date.now;
  const root = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const runId = hex(6);
  const interrupt = new Interrupt();
  let stopListening = (): void => undefined;
  let ctx: OpsContext | null = null;
  let lock: Lock | null = null;
  let writes = false;
  try {
    const environments = loadEnvironments(root);
    const names = Object.keys(environments);
    const envName = value(parsed, "--env") ?? (names.length === 1 ? (names[0] ?? "") : "");
    const environment = environments[envName];
    if (names.length === 0) throw new OpsError("kestrel.environments.json names no environment", 2, "kestrel.environments.json");
    if (environment === undefined) throw new OpsError(envName === "" ? `--env is required (${names.join(", ")})` : `unknown environment ${envName} (${names.join(", ")})`, 2, "--env");
    const named = cmd.name === "backup-verify" ? cmd.id : cmd.name === "restore" || cmd.name === "restore-local" ? cmd.backupId : null;
    const owner = named === null ? null : parseBackupId(named)?.env;
    if (named !== null && owner !== envName) throw usage(`backup ${named} belongs to environment ${owner ?? "?"}, not ${envName}`, named);
    const name = cmd.name === "restore-local" ? "restore" : cmd.name;
    const writing = name !== "status" && name !== "backup-list";
    const problems = writing ? environmentProblems(environment) : [];
    if (problems.length > 0) throw new OpsError(`${ENVIRONMENTS_FILE}: ${problems.join("; ")}`, 2, ENVIRONMENTS_FILE);
    if (writing) stopListening = interrupt.listen(options.signals ?? process);
    const stores = options.stores ?? defaultStores;
    const toolCredentials = await credentialsOf(environment.storage.credentials, `${envName}.storage.credentials`, redactor, env, options.runCommand);
    const backupStorage = environment.backups.storage ?? environment.storage;
    const backupCredentials = environment.backups.storage ? await credentialsOf(backupStorage.credentials, `${envName}.backups.storage.credentials`, redactor, env, options.runCommand) : toolCredentials;
    const app = stores(environment.storage, toolCredentials, "tool");
    const backups = environment.backups.storage ? stores(backupStorage, backupCredentials, "tool") : app;
    const workspace = createWorkspace(options.stateRoot ?? stateDir(env), runId, parsed.flags.has("--keep"));
    const target = await loadTarget(environment, options, root, clock);
    const journal = new Journal(runId, backups, environment.backups.prefix, redactor, clock, workspace.path("journal.jsonl"));
    const ask = options.prompt ?? terminalPrompt(interrupt.signal);
    const prompt: Prompt | undefined = ask && ((question) => interrupt.race(ask(redactor.apply(question))));
    ctx = {
      envName,
      env: environment,
      app: interruptible(app, interrupt),
      backups: interruptible(backups, interrupt),
      location: environment.backups.prefix,
      target,
      out,
      answers: { answers: readAnswers(value(parsed, "--answers")), yes: parsed.flags.has("--yes"), ...(prompt ? { prompt } : {}) },
      clock,
      redactor,
      workspace,
      runId,
      journal,
      tool: { name: "@michaelthielemann/kestrel-ops", version: toolVersion() },
      project: options.project ?? projectFacts(root),
      poll: options.poll ?? {},
      readyTimeoutMs: options.readyTimeoutMs ?? 300_000,
    };
    const finish = async (ok: boolean, data: Record<string, unknown>): Promise<void> => {
      await journal.finish(ok, data).catch((cause: unknown) => out.warn(`the end entry of the journal could not be written: ${messageOf(cause)}; the run counts as open for two hours`));
    };
    writes = writing;
    if (writes) {
      await journal.record("run", "started", { command: name, env: envName });
      if (parsed.flags.has("--break-lock")) await breakLocks(ctx, runId);
      lock = await acquireLock(backups, ctx.location, runId, name, clock);
    }
    switch (cmd.name) {
      case "status": {
        const appCredentials = await credentialsOf(environment.app.credentials, `${envName}.app.credentials`, redactor, env, options.runCommand);
        const appStore = appCredentials === null ? null : stores(backupStorage, appCredentials, "app");
        const report = await status(ctx, appStore);
        out.info(`${envName}: target ${report.target.state} (${report.target.instances} instance(s)), replica ${report.replica.newest ?? "empty"}${report.replica.sealed ? " sealed" : ""}, runtime ${report.replica.runtime ?? "unknown"}`);
        out.info(`backups: ${report.backups.length}, open runs: ${report.openRuns.length}, held locks: ${report.locks.length}, clock skew ${Math.round(report.clockSkewMs / 1000)} s, protected from the app: ${report.protectedFromApp}`);
        for (const problem of report.problems) out.warn(problem);
        emit("status", { ok: report.problems.length === 0, ...report });
        return report.problems.length === 0 ? 0 : 1;
      }
      case "backup-list": {
        const list = await listBackups(ctx);
        for (const b of list) out.info(`${b.id}  ${b.complete ? (b.verified === true ? "verified" : b.verified === false ? "FAILED verification" : "unverified") : "incomplete"}${b.pinnedBy.length > 0 ? `  pinned by ${b.pinnedBy.join(", ")}` : ""}`);
        emit("backup-list", { ok: true, backups: list });
        return 0;
      }
      case "backup-create": {
        const result = await createBackup(ctx, { kind: cmd.kind, mode: cmd.freeze ? { kind: "freeze" } : { kind: "live" } });
        out.info(`backup ${result.id}: db ${result.manifest.db?.bytes ?? 0} bytes, ${result.manifest.blobs.count} original(s), ${result.manifest.site.count} delivery key(s), seal ${result.manifest.source.seal}, verified`);
        await finish(true, { backupId: result.id });
        emit("backup-create", { ok: true, id: result.id, manifest: result.manifest, verification: result.verification });
        return 0;
      }
      case "backup-verify": {
        const result = await verifyBackup(ctx, cmd.id);
        for (const p of result.problems) out.error(`${p.element}: ${p.message}`);
        out.info(`backup ${cmd.id}: ${result.ok ? "verified" : "FAILED"} (${result.checked.tables} tables, ${result.checked.blobs} originals, ${result.checked.site} delivery keys, ${result.checked.sampled} hashed)`);
        await finish(result.ok, { backupId: cmd.id });
        emit("backup-verify", { ok: result.ok, verification: result });
        return result.ok ? 0 : 1;
      }
      case "backup-prune": {
        const result = await prune(ctx, cmd.dryRun);
        out.info(`${cmd.dryRun ? "would remove" : "removed"} ${result.backups.length} backup(s) and ${result.objects.length} object(s); kept ${result.kept.length}`);
        await finish(true, {});
        emit("backup-prune", { ok: true, ...result });
        return 0;
      }
      case "restore-local": {
        const result = await restoreToLocal(ctx, { dir: cmd.dir, backupId: cmd.backupId, withMedia: cmd.withMedia, keepSessions: cmd.keepSessions });
        out.info(`wrote ${result.file} (${result.sessionsDeleted} session(s) removed, ${result.originals} original(s))`);
        await finish(true, {});
        emit("restore-local", { ok: true, ...result });
        return 0;
      }
      case "restore": {
        const result = await restoreBackup(ctx, { backupId: cmd.backupId, noSafetyBackup: cmd.noSafetyBackup });
        if (result.safetyBackup !== null) await unpin(ctx, result.safetyBackup, runId).catch((cause: unknown) => out.warn(`the pre-restore backup ${result.safetyBackup ?? ""} could not be released: ${messageOf(cause)}`));
        out.info(result.noop ? `restore of ${cmd.backupId}: nothing to do` : `restored ${cmd.backupId}: ${result.originalsRestored.length} original(s) copied back, delivery ${result.delivery.written.length} written / ${result.delivery.removed.length} removed, ${result.sessionsDeleted} session(s) ended${result.promoted ? `, generation ${result.promoted.generation} (${result.acknowledgement ?? "unconfirmed"})` : ""}`);
        await finish(true, { backupId: cmd.backupId });
        emit("restore", { ok: true, ...result });
        return 0;
      }
    }
    throw usage("unknown command");
  } catch (error) {
    const opsError = error instanceof OpsError ? error : null;
    const message = messageOf(error);
    out.error(opsError?.element !== undefined && !message.includes(opsError.element) ? `${opsError.element}: ${message}` : message);
    if (ctx !== null && writes) await ctx.journal.finish(false, { message }).catch(() => undefined);
    emit("error", { ok: false, message, element: opsError?.element ?? null, ...(opsError?.backupId === undefined ? {} : { backupId: opsError.backupId }) });
    return opsError?.exitCode ?? 1;
  } finally {
    await lock?.release().catch(() => undefined);
    ctx?.workspace.dispose();
    stopListening();
  }
}
