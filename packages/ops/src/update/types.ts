import type { ModuleRun } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import type { OpsContext } from "../context.ts";
import type { UpdateSettings } from "../environments.ts";
import type { Journal } from "../journal.ts";
import type { SealState } from "../layout.ts";
import type { SealReport } from "../replica.ts";
import type { ReadyProbe, UpdateTarget } from "./target.ts";

/**
 * Exit codes of an update command. `done` (0): the command finished, for `deploy` and `resume` with the new release
 * verified. `refused` (1): a gate or check refused before production changed (no matching receipt for a version or
 * storage-shape change, more than one instance, an active rolling deployment, a staging failure), the run halted
 * because verification could not tell (403 or no connection), a question had no answer, or a rollback could not
 * finish; the output and `update status` name the state production is in and the command to run next. `usage` (2):
 * a usage or configuration error. `rolledBack` (3): a hard failure after the stop, after which the automatic rollback
 * brought back the cutover state and verified it.
 */
export const UPDATE_EXIT = { done: 0, refused: 1, usage: 2, rolledBack: 3 } as const;

/** One of {@link UPDATE_EXIT}. */
export type UpdateExitCode = (typeof UPDATE_EXIT)[keyof typeof UPDATE_EXIT];

/**
 * The phases of an update run. `prepare` rehearses on a copy and writes the receipt; `deploy` gates, stages, stops,
 * takes the cutover backup, migrates, promotes, swaps, starts and verifies; `contentMigrations` is the migration of
 * the cutover copy inside `deploy`; `verify` checks the running release again; `accept` closes the run; `rollback`
 * brings back the cutover state; `resume` and `abort` continue or end an interrupted run; `cleanup` retires what an
 * accepted update left behind.
 */
export const UPDATE_PHASES = ["prepare", "deploy", "contentMigrations", "verify", "accept", "rollback", "resume", "abort", "cleanup"] as const;
export type UpdatePhase = (typeof UPDATE_PHASES)[number];

/** The steps of `prepare`, in the order the journal records them. */
export const PREPARE_STEPS = ["preflight", "plan", "rehearsal", "receipt"] as const;

/**
 * The steps of `deploy`, in the order the journal records them. Everything up to `precopy` runs while the old release
 * serves; `stop` begins the app's downtime and `verify` ends it. `promote`, `swap` and `start` run as one step of the
 * tool without a question between them, and `retire` runs only after `verify` passed.
 */
export const DEPLOY_STEPS = ["gate", "stage", "configuration", "precopy", "stop", "seal", "cutover-backup", "migrate", "promote", "swap", "start", "verify", "retire"] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

/** The steps of the migration of the cutover copy (phase `contentMigrations`), in journal order. */
export const MIGRATE_STEPS = ["copy", "storage-migrations", "content-migrations", "migrate-check"] as const;
export type MigrateStep = (typeof MIGRATE_STEPS)[number];

/**
 * The steps of `rollback`, in journal order, between a `rollback` started record and a `rollback` done record that
 * ends it; `stop` and `seal` are skipped when the app is already stopped and sealed.
 */
export const ROLLBACK_STEPS = ["stop", "seal", "re-promote", "restore-originals", "restore-delivery", "restore-configuration", "restore-droplet", "start", "rollback-verify"] as const;
export type RollbackStep = (typeof ROLLBACK_STEPS)[number];

/** The steps of `cleanup`, in journal order. */
export const CLEANUP_STEPS = ["cleanup-check", "cleanup-delete", "unpin"] as const;

/**
 * Where an update run stands, derived from its journal. `prepared`: a prepare run wrote its receipt. `deploying`: a
 * deploy began and has not stopped the app. `untouched`: a deploy ended before the stop; production is as it was.
 * `down`: the app was stopped, or a failed stop left it stopped, and the new release is not started yet. `verifying`: the new release was started and
 * verification has not concluded. `halted`: verification could not tell. `verified`: the new release passed. `accepted`.
 * `rolling-back`. `rolled-back`. `aborted`: ended by `abort` before the promotion. `cleaned`: `cleanup` ended the run.
 */
export type UpdateRunState = "prepared" | "deploying" | "untouched" | "down" | "verifying" | "halted" | "verified" | "accepted" | "rolling-back" | "rolled-back" | "aborted" | "cleaned";

/** States in which a run needs `resume`, `rollback` or `abort` before another deploy may start. */
export const OPEN_STATES: ReadonlySet<UpdateRunState> = new Set(["deploying", "down", "verifying", "halted", "rolling-back"]);

/**
 * One record of an update run's journal, with the phase it belongs to. Each command opens with a `run` record
 * (`{ command, env, phase }`); every later record names its phase in `data.phase` or belongs to the phase of the record
 * before it. `resume` writes a `resume` record and then the steps of the phase it continues; `abort` ends with `abort`
 * done (`{ promoted }`); `accept` with `accept` done; `cleanup` with `unpin` done.
 */
export interface UpdateRecord {
  seq: number;
  step: string;
  state: "started" | "done" | "failed" | "skipped";
  at: number;
  phase: UpdatePhase;
  data: Record<string, unknown>;
}

/** An update run as its journal shows it. */
export interface UpdateRun {
  runId: string;
  env: string;
  /** Every record, in `seq` order. */
  records: UpdateRecord[];
  state: UpdateRunState;
  /** The last step that reached `done`, with its phase. */
  lastDone: { phase: UpdatePhase; step: string } | null;
  /** The highest `seq`; a process that continues the run writes from `lastSeq + 1`. */
  lastSeq: number;
  /** The receipt the gate matched, as `<planHash>/<prepare run id>`, or null for an ordinary deploy. */
  receipt: string | null;
  stagedDroplet: string | null;
  /** The droplet the app ran before the swap. */
  previousDroplet: string | null;
  cutoverBackup: string | null;
  promoted: { generation: string; nonce: string } | null;
  versions: VersionChange | null;
  startedAt: number;
  lastAt: number;
}

/** Versions of the packages whose name starts with `@michaelthielemann/kestrel`, by name. */
export type VersionSet = Record<string, string>;

/** The versions a deploy moves from and to; `from` is null when no earlier verified deploy recorded them. */
export interface VersionChange {
  from: VersionSet | null;
  to: VersionSet;
}

/** One storage-shape migration a plan found pending on a replica copy. */
export interface PlannedStorageMigration {
  module: string;
  id: string;
  kind: "auto" | "ask" | "cleanup";
  blobWrites: boolean;
  pending: number;
}

/**
 * What an update changes in the stored data, found on a copy of the replica: the storage-shape migrations pending in
 * this release's modules and the content migrations the release brings that the database's ledger does not hold.
 * Counts are informative; {@link planHash} covers ids only, so a new upload between prepare and deploy does not
 * invalidate the receipt.
 */
export interface UpdatePlan {
  versions: VersionChange;
  storage: PlannedStorageMigration[];
  content: string[];
  /** Question ids the migrations ask, answered from `--answers` in the pipeline. */
  questions: string[];
}

/** One check of the rehearsal on the production copy, with its counts. */
export interface RehearsalCheck {
  name: string;
  ok: boolean;
  detail: string;
  counts?: Record<string, number>;
}

/** What `prepare` measured while it ran the update on a copy. */
export interface Rehearsal {
  ok: boolean;
  checks: RehearsalCheck[];
  /** Milliseconds per rehearsed step, such as `migrate`, `boot` and `render`. */
  timings: Record<string, number>;
  /** Peak resident memory of the local start in bytes, or null when not measured. */
  peakRssBytes: number | null;
  fullMedia: boolean;
}

/**
 * The acknowledgement `prepare` writes once into the backup location (the update's receipt): the version change and
 * the hash of the plan it rehearsed. A deploy that changes versions or has storage migrations pending needs a receipt
 * of this environment with the same `versions.to` and `planHash`; a receipt has no expiry.
 */
export interface UpdateReceipt {
  schema: "kestrel-ops/update-receipt@1";
  env: string;
  /** The prepare run that wrote it. */
  runId: string;
  createdAt: number;
  tool: { name: string; version: string };
  versions: VersionChange;
  planHash: string;
  plan: UpdatePlan;
  rehearsal: Rehearsal;
}

/** The release a deploy stages: its directory and the versions it brings, from `bundle.json` or the project. */
export interface ReleaseFacts {
  /** Absolute directory the target stages. */
  dir: string;
  versions: VersionSet;
  lockfileSha256: string | null;
}

/**
 * Facts the host project contributes through its upgrade plugin, written into `bundle.json`: the readiness path,
 * environment names whose values are secrets, the names of the start-up migration switches, paths the export must
 * hold after a render, environment values (no secrets) of a local start and the ids of the release's content
 * migrations.
 */
export interface HostFacts {
  readyPath?: string;
  secretEnvNames?: readonly string[];
  migrationSwitches?: { content?: string; storage?: string };
  exportChecks?: readonly string[];
  localBootEnv?: Readonly<Record<string, string>>;
  /** Ids of the content migrations the release brings; a deploy applies those the database's ledger does not hold. */
  contentMigrations?: readonly string[];
}

/** Why a rollback runs. `automatic`: a hard failure after the stop. `requested`: `update rollback`. `abort`: `update abort` after the promotion. */
export type RollbackReason = { kind: "automatic"; failure: string } | { kind: "requested" } | { kind: "abort" };

/**
 * The verdict of verification. `passed`: every hard check held. `failed`: a hard check failed (no running instance,
 * crash events, readiness `not-ready`, no acknowledgement of the promoted generation, no first snapshot, a sync time
 * that does not advance, no render started), which rolls back. `unverifiable`: readiness was `unverifiable`, which halts.
 */
export type VerifyVerdict = "passed" | "failed" | "unverifiable";

/** One hard or soft check of verification. */
export interface VerifyCheck {
  name: "instance" | "crashes" | "ready" | "provenance" | "first-snapshot" | "sync-advances" | "render-started" | "pages" | "media";
  hard: boolean;
  ok: boolean;
  detail: string;
}

/** What verification needs to know about the run it checks. */
export interface VerifyInput {
  /** The generation the deploy promoted and the nonce of its `origin.json`. */
  promoted: { generation: string; nonce: string };
  /** When the start was requested, by the store's clock; keys and segments after it count as the new release's. */
  startedAt: number;
}

/** The result of verification. */
export interface VerifyResult {
  verdict: VerifyVerdict;
  checks: VerifyCheck[];
  ready: ReadyProbe;
  /** The generation the new release writes, sorting after the promoted one, or null when none appeared. */
  ownGeneration: string | null;
}

/** What the migration of the cutover copy starts from. */
export interface MigrateInput {
  /** The cutover backup whose `db.sqlite` is the starting point; a migration that was interrupted starts again from it. */
  cutoverBackup: string;
  /** The plan the gate matched; migrations it does not name are refused. */
  plan: UpdatePlan;
  /** A working file the migrated copy is written to. */
  outFile: string;
}

/** What the migration of the cutover copy did. */
export interface MigrateResult {
  /** sha256 of the migrated copy. */
  sha256: string;
  storage: ModuleRun[];
  /** Content migrations applied by the local start, in order. */
  content: string[];
  /** Tables whose rows differ from the cutover copy; only the content-migration ledger and migrated collections may. */
  changedTables: string[];
}

/** What retiring the previous releases after a passed verification did. */
export interface RetireResult {
  /** Droplets deleted. */
  droplets: string[];
  /** Revisions that named a deleted droplet and can no longer be rolled back to. */
  revisions: string[];
  /** The previous droplet's bits, saved into the backup location before it was deleted, or null when they were not saved. */
  savedDroplet: string | null;
  /** Droplets left in place: the previous one when saving its bits failed, and those another open deploy run needs. */
  kept: string[];
}

/** What a rollback did. */
export interface RollbackResult {
  /** `previous-release`: the old droplet runs on the cutover state. `stopped`: the cutover state is promoted but no old droplet was left to start; the app stays stopped. */
  ended: "previous-release" | "stopped";
  /** The generation the rollback promoted from the cutover backup. */
  generation: string;
  seal: SealState;
  delivery: { written: string[]; removed: string[]; relisted: number };
  originalsRestored: string[];
  configuration: { set: string[]; removed: string[]; unrestorable: string[] };
  /** Keys of a derived prefix whose ETag differs from the cutover backup's listing. */
  derivedChanged: string[];
}

/** Time spent in one step, and whether the app was down during it. */
export interface StepTiming {
  phase: UpdatePhase;
  step: string;
  startedAt: number;
  endedAt: number | null;
  ms: number | null;
  appDown: boolean;
}

/** The timings of a run: every step, and the app's downtime from the stop until verification passed or the rollback started the old release. */
export interface UpdateReport {
  runId: string;
  steps: StepTiming[];
  downtimeMs: number | null;
}

/** How an update command ended. */
export interface UpdateOutcome {
  exitCode: UpdateExitCode;
  runId: string;
  state: UpdateRunState;
  /** One line for the operator, such as the next command to run. */
  message: string;
  report: UpdateReport;
}

/**
 * The steps one phase uses from another, injected so each phase can be tested on its own. {@link defaultSteps} wires
 * the real ones.
 */
export interface UpdateSteps {
  waitForSeal(ctx: UpdateContext, stoppedAt: number): Promise<SealReport>;
  migrateCopy(ctx: UpdateContext, input: MigrateInput): Promise<MigrateResult>;
  verify(ctx: UpdateContext, input: VerifyInput): Promise<VerifyResult>;
  rollback(ctx: UpdateContext, run: UpdateRun, reason: RollbackReason): Promise<RollbackResult>;
  retire(ctx: UpdateContext, run: UpdateRun): Promise<RetireResult>;
  continueDeploy(ctx: UpdateContext, run: UpdateRun): Promise<UpdateOutcome>;
}

/**
 * Everything an update command works with. `journal` writes into the journal of the update run `run.id`, continuing
 * its numbering: that run is this process's `runId` for `prepare` and `deploy`, and the deploy's run for every later
 * command. `runId` stays this process's own, for the lock and the working directory.
 */
export interface UpdateContext extends OpsContext {
  target: UpdateTarget;
  journal: Journal;
  update: UpdateSettings;
  release: ReleaseFacts;
  host: HostFacts;
  run: { id: string };
  steps: UpdateSteps;
}
