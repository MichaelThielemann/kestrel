import { createHash } from "node:crypto";
import type { Blobstore, BlobstoreError, PutOptions } from "../blobstore.ts";
import { customFailure, err, isErr, ok, type KestrelError, type Result } from "../errors.ts";
import type { Document, Persistence, PersistenceError, Schema } from "../persistence.ts";

/** The collection that holds one storage version row per module. */
export const STORAGE_VERSIONS = "kestrel_storage_versions";

/** The schema of {@link STORAGE_VERSIONS}; `module` is unique. */
export const STORAGE_VERSIONS_SCHEMA: Schema = { module: { type: "string", unique: true }, version: "string", migrations: "json", updatedAt: "number" };

/** The command a refusal names for running storage migrations offline on a copy of the data. */
export const OFFLINE_COMMAND = "kestrel upgrade migrate --db <file> --blobs-dir <dir>";

/** The command a refusal names for running storage migrations as part of a full update. */
export const UPDATE_COMMAND = "kestrel update";

/**
 * `STORAGE_REFUSED`: a module's stored data does not match the release and the run may not convert it
 * (pending migrations in `check` mode or with blob writes at start-up, data too old or too new).
 * `STORAGE_MIGRATION_FAILED`: a migration's `apply` or `verify` failed, or the version collection holds rows
 * this helper did not write. The other codes come from the persistence or the blob store.
 */
export type ShapeMigrationError = KestrelError<"STORAGE_REFUSED" | "STORAGE_MIGRATION_FAILED" | "CONFLICT" | "NOT_FOUND" | "TRANSIENT">;

/** `auto` runs without a question, `ask` needs an answer for each of its questions, `cleanup` removes an old form after the update was accepted. */
export type MigrationKind = "auto" | "ask" | "cleanup";

/** A stored blob's size and, when the store knows it without reading the bytes, its sha256 as lower-case hex. */
export interface BlobHead {
  size: number;
  sha256: string | null;
}

/**
 * The blob operations a migration may use. A runner with server-side copies injects its own; {@link blobOpsOf}
 * builds them from any `blobstore@1` by reading and writing the bytes.
 */
export interface BlobOps {
  /** Copies `from` to `to`, replacing `to`; `NOT_FOUND` when `from` is missing. */
  copy(from: string, to: string, options?: PutOptions): Promise<Result<void, BlobstoreError>>;
  /** `Ok(null)` when `key` is missing. */
  head(key: string): Promise<Result<BlobHead | null, BlobstoreError>>;
}

/** A question a migration asks; `default` is the safe answer and never destroys data. */
export interface MigrationQuestion {
  id: string;
  text: string;
  choices: readonly string[];
  default: string;
}

/** What a migration is given. `answers` maps question ids to the chosen answer; a missing answer means the question's `default`. */
export interface MigrationContext {
  db: Persistence;
  blobs: Blobstore;
  blobOps: BlobOps;
  answers: Readonly<Record<string, string>>;
  now(): number;
}

/** How much of the old form a migration found: `pending` items and a few of their ids or keys. */
export interface Detection {
  pending: number;
  sample: string[];
}

/** One item a migration did not convert as asked, or converted with a finding the operator should see. */
export interface MigrationNote {
  item: string;
  reason: string;
}

/** What a migration would do, counted without writing anything. */
export interface MigrationPlan {
  counts: Record<string, number>;
  notes: MigrationNote[];
}

/** What a migration did. */
export interface MigrationOutcome {
  counts: Record<string, number>;
  notes: MigrationNote[];
}

/**
 * One storage-shape migration of a module. `detect` finds the old form and reports nothing once it is gone;
 * `plan` counts without writing; `apply` converts in chunks, each item idempotently, so a rerun after an abort
 * continues where it stopped, and it writes new keys before rows switch to them and never deletes or overwrites an
 * authoritative row or blob; `verify` defaults to `detect` reporting nothing. Blobs are reached through
 * `ctx.blobOps` and `ctx.blobs` only; a migration with `blobWrites` never runs at start-up.
 */
export interface ShapeMigration {
  /** `<package>:<name>`, e.g. `media-default:id-key-layout`. */
  id: string;
  /** The release whose storage shape this migration produces, e.g. `6.0.0`. */
  introducedIn: string;
  kind: MigrationKind;
  blobWrites: boolean;
  summary: string;
  questions?: readonly MigrationQuestion[];
  detect(ctx: MigrationContext): Promise<Result<Detection, ShapeMigrationError>>;
  plan(ctx: MigrationContext): Promise<Result<MigrationPlan, ShapeMigrationError>>;
  apply(ctx: MigrationContext): Promise<Result<MigrationOutcome, ShapeMigrationError>>;
  verify?(ctx: MigrationContext): Promise<Result<Detection, ShapeMigrationError>>;
}

/**
 * A module's storage: the shape `version` this release writes, the oldest stored version its migrations
 * convert (`convertsFrom`), the modules whose migrations run before its own, and the migrations.
 */
export interface ModuleStorage {
  /** The module name, e.g. `media/default`. */
  module: string;
  version: string;
  convertsFrom: string;
  dependsOn?: readonly string[];
  migrations: readonly ShapeMigration[];
}

/** A module's row in {@link STORAGE_VERSIONS}: the shape version of its stored data and the migrations whose form the data has. */
export interface StorageVersion extends Document {
  module: string;
  version: string;
  migrations: string[];
  updatedAt: number;
}

/** `not-needed`: `detect` found nothing. `pending`: found, not applied by this run (`blocked` says why). `applied`: applied and verified. */
export type MigrationState = "not-needed" | "pending" | "applied";

export interface MigrationRun {
  id: string;
  introducedIn: string;
  kind: MigrationKind;
  blobWrites: boolean;
  state: MigrationState;
  detected: Detection;
  blocked?: "plan-only" | "blob-writes" | "earlier-pending" | "dependency-pending";
  plan?: MigrationPlan;
  outcome?: MigrationOutcome;
}

/**
 * `current`: the version row already matched. `recorded`: nothing was pending and the row was written.
 * `migrated`: migrations were applied and the row was written. `pending`: migrations wait, the row is unchanged.
 * `too-old` / `too-new`: the stored version is outside what this release reads, nothing ran.
 */
export type ModuleState = "current" | "recorded" | "migrated" | "pending" | "too-old" | "too-new";

export interface ModuleRun {
  module: string;
  stored: string | null;
  version: string;
  state: ModuleState;
  migrations: MigrationRun[];
}

export interface RunReport {
  modules: ModuleRun[];
}

/** What {@link runShapeMigrations} runs. `apply: false` only detects and plans. `blobWrites: false` leaves every migration with `blobWrites` pending. */
export interface RunOptions {
  storages: readonly ModuleStorage[];
  db: Persistence;
  blobs: Blobstore;
  blobOps?: BlobOps;
  apply: boolean;
  blobWrites: boolean;
  answers?: Readonly<Record<string, string>>;
  now?: () => number;
}

/** A module's `storageMigrations` setting: `check` refuses to start on data that needs a migration, `apply` runs the migrations without blob writes at start-up. */
export type StorageMigrationsMode = "check" | "apply";

const PAGE = 200;

/** A `STORAGE_MIGRATION_FAILED` error for a migration's `apply` or `verify`. */
export function storageMigrationFailed(message: string, details: Record<string, unknown> = {}): ShapeMigrationError {
  return customFailure("STORAGE_MIGRATION_FAILED", 500, message, { details });
}

function refused(message: string, details: Record<string, unknown>): ShapeMigrationError {
  return customFailure("STORAGE_REFUSED", 409, message, { details });
}

function parts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error(`shape-migrations: "${version}" is not a version of the form <major>.<minor>.<patch>`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compares two `<major>.<minor>.<patch>` versions; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  }
  return 0;
}

function majorOf(version: string): number {
  return parts(version)[0];
}

/** The sha256 of `data` as lower-case hex. */
export function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Blob operations over any `blobstore@1`: `copy` reads and writes the bytes, `head` reads them for size and sha256. */
export function blobOpsOf(blobs: Blobstore): BlobOps {
  return {
    async copy(from, to, options) {
      const read = await blobs.get(from);
      if (isErr(read)) return read;
      if (read.value === null) return err(customFailure("NOT_FOUND", 404, `shape-migrations: blob ${from} not found`));
      return blobs.put(to, read.value, options);
    },
    async head(key) {
      const read = await blobs.get(key);
      if (isErr(read)) return read;
      return ok(read.value === null ? null : { size: read.value.byteLength, sha256: sha256Of(read.value) });
    },
  };
}

/** The sha256 of the blob at `key`, from `head` when the store knows it, else from reading the bytes; `Ok(null)` when it is missing. */
export async function blobSha256(ctx: Pick<MigrationContext, "blobs" | "blobOps">, key: string, head?: BlobHead | null): Promise<Result<string | null, BlobstoreError>> {
  const known = head === undefined ? await ctx.blobOps.head(key) : ok(head);
  if (isErr(known)) return known;
  if (known.value === null) return ok(null);
  if (known.value.sha256 !== null) return ok(known.value.sha256);
  const read = await ctx.blobs.get(key);
  if (isErr(read)) return read;
  return ok(read.value === null ? null : sha256Of(read.value));
}

/** The answer to `question` in `ctx`, or its default; an answer outside its choices is refused. */
export function answerOf(ctx: Pick<MigrationContext, "answers">, question: MigrationQuestion): Result<string, ShapeMigrationError> {
  const given = ctx.answers[question.id];
  if (given === undefined) return ok(question.default);
  if (!question.choices.includes(given)) return err(refused(`answer "${given}" to ${question.id} is not one of ${question.choices.join(", ")}`, { question: question.id }));
  return ok(given);
}

/** Orders modules so that each comes after the modules it depends on, and otherwise by name. A dependency that is not in the list is ignored. */
export function orderStorages(storages: readonly ModuleStorage[]): ModuleStorage[] {
  const byName = new Map(storages.map((s) => [s.module, s]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ModuleStorage[] = [];
  const visit = (storage: ModuleStorage): void => {
    if (done.has(storage.module)) return;
    if (visiting.has(storage.module)) throw new Error(`shape-migrations: modules depend on each other in a cycle through ${storage.module}`);
    visiting.add(storage.module);
    for (const name of [...(storage.dependsOn ?? [])].sort()) {
      const dependency = byName.get(name);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(storage.module);
    done.add(storage.module);
    ordered.push(storage);
  };
  for (const storage of [...storages].sort((a, b) => (a.module < b.module ? -1 : a.module > b.module ? 1 : 0))) visit(storage);
  return ordered;
}

/** A module's migrations ordered by `introducedIn`, then by id. */
export function orderMigrations(migrations: readonly ShapeMigration[]): ShapeMigration[] {
  return [...migrations].sort((a, b) => compareVersions(a.introducedIn, b.introducedIn) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isStorageVersion(row: Document): row is StorageVersion {
  return typeof row.module === "string" && typeof row.version === "string" && Array.isArray(row.migrations) && row.migrations.every((m) => typeof m === "string");
}

/**
 * Prepares {@link STORAGE_VERSIONS} and returns its rows by module. A row without a string `module`, a version string and a
 * list of migration ids was not written by this helper: the collection name is taken, and the run fails instead of guessing.
 */
export async function readStorageVersions(db: Persistence): Promise<Result<Map<string, StorageVersion>, ShapeMigrationError>> {
  const prepared = await db.ensureCollection(STORAGE_VERSIONS, STORAGE_VERSIONS_SCHEMA);
  if (isErr(prepared)) return prepared;
  const rows = new Map<string, StorageVersion>();
  let cursor: string | null = null;
  for (;;) {
    const page: Result<{ items: Document[] }, PersistenceError> = await db.findMany<Document>(STORAGE_VERSIONS, cursor === null ? {} : { id: { gt: cursor } }, { sort: { id: "asc" }, limit: PAGE });
    if (isErr(page)) return page;
    for (const row of page.value.items) {
      if (!isStorageVersion(row)) return err(storageMigrationFailed(`collection "${STORAGE_VERSIONS}" holds a row (${row.id}) that is not a storage version row; another component uses this collection name`, { collection: STORAGE_VERSIONS, id: row.id }));
      rows.set(row.module, row);
    }
    if (page.value.items.length < PAGE) return ok(rows);
    cursor = page.value.items[page.value.items.length - 1]!.id;
  }
}

async function writeVersion(db: Persistence, existing: StorageVersion | undefined, module: string, version: string, migrations: string[], at: number): Promise<Result<void, ShapeMigrationError>> {
  const merged = [...new Set([...(existing?.migrations ?? []), ...migrations])];
  const written = existing === undefined
    ? await db.createOne<StorageVersion>(STORAGE_VERSIONS, { module, version, migrations: merged, updatedAt: at })
    : await db.updateOne<StorageVersion>(STORAGE_VERSIONS, existing.id, { version, migrations: merged, updatedAt: at });
  return isErr(written) ? written : ok();
}

function contextOf(options: RunOptions): MigrationContext {
  return { db: options.db, blobs: options.blobs, blobOps: options.blobOps ?? blobOpsOf(options.blobs), answers: options.answers ?? {}, now: options.now ?? Date.now };
}

/**
 * Brings each module's stored data to the shape of this release. Modules run in dependency order, a module's
 * migrations by `introducedIn`. A module's version row is read first: equal to `version` means nothing runs; newer
 * than `version`, or older than `convertsFrom`, leaves the module untouched (`too-new` / `too-old`). Otherwise every
 * migration introduced after the stored version (all of them when there is no row) is detected and, when allowed,
 * planned, applied and verified. The version row is written only after every pending migration of the module has
 * been verified. A failing `apply` or `verify` ends the run with `Err`; rerunning continues where it stopped.
 */
export async function runShapeMigrations(options: RunOptions): Promise<Result<RunReport, ShapeMigrationError>> {
  const ctx = contextOf(options);
  const versions = await readStorageVersions(options.db);
  if (isErr(versions)) return versions;
  const modules: ModuleRun[] = [];
  const unfinished = new Set<string>();
  for (const storage of orderStorages(options.storages)) {
    const row = versions.value.get(storage.module);
    const stored = row?.version ?? null;
    const run: ModuleRun = { module: storage.module, stored, version: storage.version, state: "current", migrations: [] };
    modules.push(run);
    if (stored !== null && compareVersions(stored, storage.version) === 0) continue;
    if (stored !== null && compareVersions(stored, storage.version) > 0) {
      run.state = "too-new";
      unfinished.add(storage.module);
      continue;
    }
    if (stored !== null && compareVersions(stored, storage.convertsFrom) < 0) {
      run.state = "too-old";
      unfinished.add(storage.module);
      continue;
    }
    const dependencyPending = (storage.dependsOn ?? []).some((name) => unfinished.has(name));
    const applied: string[] = [];
    let waiting = false;
    for (const migration of orderMigrations(storage.migrations)) {
      if (stored !== null && compareVersions(migration.introducedIn, stored) <= 0) continue;
      const detected = await migration.detect(ctx);
      if (isErr(detected)) return detected;
      const entry: MigrationRun = { id: migration.id, introducedIn: migration.introducedIn, kind: migration.kind, blobWrites: migration.blobWrites, state: "not-needed", detected: detected.value };
      run.migrations.push(entry);
      if (detected.value.pending === 0) continue;
      entry.state = "pending";
      const planned = await migration.plan(ctx);
      if (isErr(planned)) return planned;
      entry.plan = planned.value;
      const blocked = !options.apply ? "plan-only" : waiting ? "earlier-pending" : dependencyPending ? "dependency-pending" : migration.blobWrites && !options.blobWrites ? "blob-writes" : undefined;
      if (blocked !== undefined) {
        entry.blocked = blocked;
        waiting = true;
        continue;
      }
      const outcome = await migration.apply(ctx);
      if (isErr(outcome)) return outcome;
      entry.outcome = outcome.value;
      const verified = migration.verify === undefined ? await migration.detect(ctx) : await migration.verify(ctx);
      if (isErr(verified)) return verified;
      if (verified.value.pending > 0) {
        return err(storageMigrationFailed(`${storage.module}: ${migration.id} left ${verified.value.pending} item(s) in the old form (e.g. ${verified.value.sample.slice(0, 3).join(", ")}); run it again, or restore the copy it ran on`, { module: storage.module, migration: migration.id, pending: verified.value.pending, sample: verified.value.sample }));
      }
      entry.state = "applied";
      applied.push(migration.id);
    }
    if (waiting) {
      run.state = "pending";
      unfinished.add(storage.module);
      continue;
    }
    const written = await writeVersion(options.db, row, storage.module, storage.version, run.migrations.map((m) => m.id), ctx.now());
    if (isErr(written)) return written;
    run.state = applied.length > 0 ? "migrated" : "recorded";
  }
  return ok({ modules });
}

function pendingText(migration: MigrationRun): string {
  const sample = migration.detected.sample.length === 0 ? "" : `, e.g. ${migration.detected.sample.slice(0, 3).join(", ")}`;
  return `${migration.id} (introduced in ${migration.introducedIn}; ${migration.detected.pending} item(s)${sample})`;
}

/** The refusal for a module the run left `pending`, `too-old` or `too-new`, naming the migrations and the command that runs them; `null` otherwise. */
export function refusalOf(run: ModuleRun, mode: StorageMigrationsMode): string | null {
  if (run.state === "too-new") return `${run.module}: the stored data has storage version ${run.stored ?? "?"}, newer than ${run.version} of this release; start the release that wrote it, or restore the backup taken before the update`;
  if (run.state === "too-old") return `${run.module}: the stored data has storage version ${run.stored ?? "?"}, older than this release converts; update through ${majorOf(run.version) - 1}.x first`;
  if (run.state !== "pending") return null;
  const waiting = run.migrations.filter((m) => m.state === "pending");
  const withBlobs = waiting.filter((m) => m.blobWrites);
  const listed = waiting.map(pendingText).join("; ");
  const offline = `run ${waiting.length === 1 ? "it" : "them"} on a copy of the data with \`${OFFLINE_COMMAND}\`, or let \`${UPDATE_COMMAND}\` run ${waiting.length === 1 ? "it" : "them"}`;
  if (mode === "apply" && withBlobs.length > 0) return `${run.module}: the stored data needs storage migration ${listed}; a migration that writes blobs never runs at start-up – ${offline}, then start this release`;
  if (withBlobs.length > 0) return `${run.module}: the stored data needs storage migration ${listed}; ${offline}, then start this release`;
  return `${run.module}: the stored data needs storage migration ${listed}; set storageMigrations: "apply" to run it at start-up, or ${offline}`;
}

/**
 * The start-up guard of a module with storage migrations. `check` detects and refuses data in an old form;
 * `apply` also runs the migrations without blob writes. A migration with blob writes never runs here. On data
 * that needs nothing the module's version row is recorded. The refusal is `STORAGE_REFUSED`, its message names
 * the migration ids and the command that runs them.
 */
export async function guardStorage(storage: ModuleStorage, options: { db: Persistence; blobs: Blobstore; mode: StorageMigrationsMode; now?: () => number }): Promise<Result<ModuleRun, ShapeMigrationError>> {
  const report = await runShapeMigrations({ storages: [storage], db: options.db, blobs: options.blobs, apply: options.mode === "apply", blobWrites: false, ...(options.now === undefined ? {} : { now: options.now }) });
  if (isErr(report)) return report;
  const run = report.value.modules[0]!;
  const refusal = refusalOf(run, options.mode);
  if (refusal !== null) return err(refused(refusal, { module: run.module, stored: run.stored, version: run.version, migrations: run.migrations.filter((m) => m.state === "pending").map((m) => m.id) }));
  return ok(run);
}

/** The storage-shape version row of `module`, or `Ok(null)` when it has none. */
export async function storageVersionOf(db: Persistence, module: string): Promise<Result<StorageVersion | null, ShapeMigrationError>> {
  const versions = await readStorageVersions(db);
  if (isErr(versions)) return versions;
  return ok(versions.value.get(module) ?? null);
}
