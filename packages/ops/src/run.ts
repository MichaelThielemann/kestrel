import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { createBackup, listBackups, prune, unpin, verifyBackup } from "./backup.ts";
import type { OpsContext } from "./context.ts";
import { resolveCredential, type CommandRunner } from "./credentials.ts";
import { loadEnvironments, type Environment, type StorageConfig } from "./environments.ts";
import { OpsError } from "./errors.ts";
import { Journal } from "./journal.ts";
import { hex, parseJson, type BackupKind } from "./layout.ts";
import { acquireLock, type Lock } from "./lock.ts";
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
common options: --env <name>, --json, --yes, --answers <file>, --keep (keep the local working directory)
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

const KNOWN_FLAGS = new Set([...VALUE_FLAGS, "--freeze", "--dry-run", "--no-safety-backup", "--latest", "--with-media", "--keep-sessions", "--json", "--yes", "--keep"]);

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

function readAnswers(file: string | null, root: string): Record<string, string> {
  if (file === null) return {};
  const value = parseJson(new Uint8Array(readFileSync(resolve(root, file))));
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.values(value).every((v) => typeof v === "string")) throw new OpsError(`${file}: answers must map question ids to strings`, 2, "--answers");
  return boundaryCast<Record<string, string>>(value, "json");
}

/** A prompt on the terminal, or undefined when stdin is not one. */
export function terminalPrompt(): Prompt | undefined {
  if (!process.stdin.isTTY) return undefined;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(question);
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
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    stderr(`error: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  const json = parsed.flags.has("--json");
  const out = createOutput(redactor, stdout, stderr, json);
  const [command, sub, ...rest] = parsed.positional;
  const unknown = [...parsed.flags.keys()].filter((f) => !KNOWN_FLAGS.has(f));
  const toLocal = command === "restore" && parsed.flags.has("--to");
  const valid = (command === "status" && sub === undefined) || (command === "backup" && ["create", "list", "verify", "prune"].includes(sub ?? "") && rest.length === (sub === "verify" ? 1 : 0)) || (command === "restore" && rest.length === 0 && (sub === undefined || toLocal));
  if (!valid || unknown.length > 0) {
    stderr(`${unknown.length > 0 ? `error: unknown option ${unknown.join(", ")}\n` : ""}${USAGE}\n`);
    return 2;
  }
  const clock = options.clock ?? Date.now;
  const root = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const runId = hex(6);
  let ctx: OpsContext | null = null;
  let lock: Lock | null = null;
  let writes = false;
  const emit = (name: string, payload: Record<string, unknown>): void => {
    if (json) stdout(redactor.json({ schema: `kestrel-ops/${name}@1`, ...payload }, 2) + "\n");
  };
  try {
    const environments = loadEnvironments(root);
    const names = Object.keys(environments);
    const envName = value(parsed, "--env") ?? (names.length === 1 ? (names[0] ?? "") : "");
    const environment = environments[envName];
    if (names.length === 0) throw new OpsError("kestrel.environments.json names no environment", 2, "kestrel.environments.json");
    if (environment === undefined) throw new OpsError(envName === "" ? `--env is required (${names.join(", ")})` : `unknown environment ${envName} (${names.join(", ")})`, 2, "--env");
    const stores = options.stores ?? defaultStores;
    const toolCredentials = await credentialsOf(environment.storage.credentials, `${envName}.storage.credentials`, redactor, env, options.runCommand);
    const backupStorage = environment.backups.storage ?? environment.storage;
    const backupCredentials = environment.backups.storage ? await credentialsOf(backupStorage.credentials, `${envName}.backups.storage.credentials`, redactor, env, options.runCommand) : toolCredentials;
    const appCredentials = await credentialsOf(environment.app.credentials, `${envName}.app.credentials`, redactor, env, options.runCommand);
    const app = stores(environment.storage, toolCredentials, "tool");
    const backups = environment.backups.storage ? stores(backupStorage, backupCredentials, "tool") : app;
    const workspace = createWorkspace(options.stateRoot ?? stateDir(env), runId, parsed.flags.has("--keep"));
    const target = await loadTarget(environment, options, root, clock);
    const journal = new Journal(runId, backups, environment.backups.prefix, redactor, clock, workspace.path("journal.jsonl"));
    const prompt = options.prompt ?? terminalPrompt();
    ctx = {
      envName,
      env: environment,
      app,
      backups,
      location: environment.backups.prefix,
      target,
      out,
      answers: { answers: readAnswers(value(parsed, "--answers"), root), yes: parsed.flags.has("--yes"), ...(prompt ? { prompt } : {}) },
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
    const name = command === "restore" ? "restore" : sub === undefined ? (command ?? "") : `${command ?? ""}-${sub}`;
    writes = name !== "status" && name !== "backup-list";
    if (writes) {
      await journal.record("run", "started", { command: name, env: envName });
      lock = await acquireLock(backups, ctx.location, runId, name, clock);
    }
    if (name === "status") {
      const appStore = appCredentials === null ? null : stores(environment.storage, appCredentials, "app");
      const report = await status(ctx, appStore);
      out.info(`${envName}: target ${report.target.state} (${report.target.instances} instance(s)), replica ${report.replica.newest ?? "empty"}${report.replica.sealed ? " sealed" : ""}, runtime ${report.replica.runtime ?? "unknown"}`);
      out.info(`backups: ${report.backups.length}, open runs: ${report.openRuns.length}, held locks: ${report.locks.length}, clock skew ${Math.round(report.clockSkewMs / 1000)} s, protected from the app: ${report.protectedFromApp}`);
      for (const problem of report.problems) out.warn(problem);
      emit("status", { ok: report.problems.length === 0, ...report });
      return report.problems.length === 0 ? 0 : 1;
    }
    if (name === "backup-list") {
      const list = await listBackups(ctx);
      for (const b of list) out.info(`${b.id}  ${b.complete ? (b.verified === true ? "verified" : b.verified === false ? "FAILED verification" : "unverified") : "incomplete"}${b.pinnedBy.length > 0 ? `  pinned by ${b.pinnedBy.join(", ")}` : ""}`);
      emit("backup-list", { ok: true, backups: list });
      return 0;
    }
    if (name === "backup-create") {
      const kindFlag = value(parsed, "--kind") ?? "manual";
      if (kindFlag !== "manual" && kindFlag !== "scheduled" && kindFlag !== "cutover") throw new OpsError(`--kind must be manual, scheduled or cutover`, 2, "--kind");
      const kind: BackupKind = kindFlag;
      const result = await createBackup(ctx, { kind, mode: parsed.flags.has("--freeze") ? { kind: "freeze" } : { kind: "live" } });
      out.info(`backup ${result.id}: db ${result.manifest.db.bytes} bytes, ${result.manifest.blobs.count} original(s), ${result.manifest.site.count} delivery key(s), seal ${result.manifest.source.seal}, verified`);
      emit("backup-create", { ok: true, id: result.id, manifest: result.manifest, verification: result.verification });
      await ctx.journal.finish(true, { backupId: result.id });
      return 0;
    }
    if (name === "backup-verify") {
      const id = rest[0] ?? "";
      const result = await verifyBackup(ctx, id);
      for (const p of result.problems) out.error(`${p.element}: ${p.message}`);
      out.info(`backup ${id}: ${result.ok ? "verified" : "FAILED"} (${result.checked.tables} tables, ${result.checked.blobs} originals, ${result.checked.site} delivery keys, ${result.checked.sampled} hashed)`);
      emit("backup-verify", { ok: result.ok, verification: result });
      await ctx.journal.finish(result.ok, { backupId: id });
      return result.ok ? 0 : 1;
    }
    if (name === "backup-prune") {
      const dryRun = parsed.flags.has("--dry-run");
      const result = await prune(ctx, dryRun);
      out.info(`${dryRun ? "would remove" : "removed"} ${result.backups.length} backup(s) and ${result.objects.length} object(s); kept ${result.kept.length}`);
      emit("backup-prune", { ok: true, ...result });
      await ctx.journal.finish(true, {});
      return 0;
    }
    const to = value(parsed, "--to");
    if (to !== null) {
      if (to !== "local") throw new OpsError("--to takes local <dir>", 2, "--to");
      const dir = sub;
      if (dir === undefined) throw new OpsError("restore --to local needs a directory", 2, "--to");
      const backupId = value(parsed, "--backup");
      if ((backupId === null) === !parsed.flags.has("--latest")) throw new OpsError("restore --to local needs --backup <id> or --latest", 2, "--backup");
      const result = await restoreToLocal(ctx, { dir, backupId, withMedia: parsed.flags.has("--with-media"), keepSessions: parsed.flags.has("--keep-sessions") });
      out.info(`wrote ${result.file} (${result.sessionsDeleted} session(s) removed, ${result.originals} original(s))`);
      emit("restore-local", { ok: true, ...result });
      await ctx.journal.finish(true, {});
      return 0;
    }
    const backupId = value(parsed, "--backup");
    if (backupId === null) throw new OpsError("restore needs --backup <id> or --to local <dir>", 2, "--backup");
    const result = await restoreBackup(ctx, { backupId, noSafetyBackup: parsed.flags.has("--no-safety-backup") });
    if (result.safetyBackup !== null) await unpin(ctx, result.safetyBackup, runId);
    out.info(result.noop ? `restore of ${backupId}: nothing to do` : `restored ${backupId}: ${result.originalsRestored.length} original(s) copied back, delivery ${result.delivery.written.length} written / ${result.delivery.removed.length} removed, ${result.sessionsDeleted} session(s) ended${result.promoted ? `, generation ${result.promoted.generation} (${result.acknowledgement ?? "unconfirmed"})` : ""}`);
    emit("restore", { ok: true, ...result });
    await ctx.journal.finish(true, { backupId });
    return 0;
  } catch (error) {
    const opsError = error instanceof OpsError ? error : null;
    const message = error instanceof Error ? error.message : String(error);
    out.error(opsError?.element !== undefined && !message.includes(opsError.element) ? `${opsError.element}: ${message}` : message);
    emit("error", { ok: false, message, element: opsError?.element ?? null });
    if (ctx !== null && writes) await ctx.journal.finish(false, { message }).catch(() => undefined);
    return opsError?.exitCode ?? 1;
  } finally {
    await lock?.release().catch(() => undefined);
    ctx?.workspace.dispose();
  }
}
