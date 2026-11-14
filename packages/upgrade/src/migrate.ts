import { existsSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import { err, isErr, type Result } from "@michaelthielemann/kestrel/result";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { runShapeMigrations, type ModuleRun } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { isRecord } from "./guards.ts";
import { importInstalled } from "./installed.ts";
import type { UpgradePlugin } from "./plugin.ts";
import { projectStorages, type ProjectStorages } from "./storages.ts";
import { toolVersion } from "./versions.ts";

/** The JSON `kestrel upgrade migrate --json` prints. `applied` is `false` for a `--plan` run. */
export interface MigrateReport {
  schema: 1;
  tool: { name: "kestrel-upgrade"; version: string };
  command: "migrate";
  db: string;
  blobsDir: string;
  applied: boolean;
  modules: ModuleRun[];
  notes: string[];
}

/** What {@link runMigrateStep} returns: the exit code, and the report or the reason it could not run. */
export interface MigrateStepResult {
  exitCode: number;
  report?: MigrateReport;
  error?: string;
}

/** The inputs of {@link runMigrateStep}. `wrap` lets a caller observe or interpose on the stores the run writes through. */
export interface MigrateStepOptions {
  dbFile: string;
  blobsDir: string;
  root: string;
  plan?: boolean;
  answers?: Readonly<Record<string, string>>;
  now?: () => number;
  wrap?: (stores: { db: Persistence; blobs: Blobstore }) => { db: Persistence; blobs: Blobstore };
  /** The host plugins the module configs are loaded through when `kestrel.config.ts` does not load by itself. */
  plugins?: readonly UpgradePlugin[];
  /** The media key prefix to convert to, in place of the one of `media-default`'s config. */
  mediaPrefix?: string;
  /** Confirms that `blobsDir` is the root of the copied blob store although none of the originals is under it, so the answer to `media-default:id-key-layout:missing-original` applies to every item. */
  originalsGone?: boolean;
}

interface ClosablePersistence extends Persistence {
  close(): void;
}

interface PersistenceSqliteModule {
  createPersistenceSqlite(config: { file: string }, deps?: { logger?: unknown }): ClosablePersistence;
}

interface BlobstoreFilesystemModule {
  createBlobstoreFilesystem(config: { root: string }): Blobstore;
}

const UNREADABLE_CODES = new Set([3, 5, 6, 8, 10, 13, 14]);

function unreadable(thrown: unknown): boolean {
  if (!isRecord(thrown)) return false;
  if (typeof thrown.errcode === "number") return UNREADABLE_CODES.has(thrown.errcode & 0xff);
  return thrown.code === "ENOSPC" || thrown.code === "EACCES" || thrown.code === "EPERM" || thrown.code === "EROFS";
}

type QuickCheck = { ok: true } | { ok: false; unreadable: boolean; reason: string };

function quickCheck(file: string): QuickCheck {
  const failed = (thrown: unknown): QuickCheck => ({ ok: false, unreadable: unreadable(thrown), reason: thrown instanceof Error ? thrown.message : String(thrown) });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (thrown) {
    return failed(thrown);
  }
  try {
    const rows = boundaryCast<Array<Record<string, unknown>>>(db.prepare("PRAGMA quick_check").all(), "host");
    return rows.length === 1 && Object.values(rows[0]!)[0] === "ok" ? { ok: true } : { ok: false, unreadable: false, reason: "PRAGMA quick_check did not answer ok" };
  } catch (thrown) {
    return failed(thrown);
  } finally {
    db.close();
  }
}

async function persistenceOf(root: string): Promise<PersistenceSqliteModule | undefined> {
  const mod = await importInstalled(root, "@michaelthielemann/kestrel-persistence-sqlite/impl");
  return isRecord(mod) && typeof mod.createPersistenceSqlite === "function" ? boundaryCast<PersistenceSqliteModule>(mod, "host") : undefined;
}

async function blobstoreOf(root: string): Promise<BlobstoreFilesystemModule | undefined> {
  const mod = await importInstalled(root, "@michaelthielemann/kestrel-blobstore-filesystem/impl");
  return isRecord(mod) && typeof mod.createBlobstoreFilesystem === "function" ? boundaryCast<BlobstoreFilesystemModule>(mod, "host") : undefined;
}

async function guarded<T>(task: () => Promise<Result<T, { message: string }>>): Promise<Result<T, string>> {
  try {
    const result = await task();
    return isErr(result) ? err(result.error.message) : result;
  } catch (thrown) {
    return err(thrown instanceof Error ? thrown.message : String(thrown));
  }
}

const MISSING_ORIGINALS = { migration: "media-default:id-key-layout", question: "media-default:id-key-layout:missing-original" } as const;

interface OriginalsCheck {
  blobsDir: string;
  prefix: string;
  nowhere: boolean;
  originalsGone: boolean;
}

interface MissingOriginals {
  stop?: string;
  note?: string;
}

const ENTRIES_SHOWN = 5;

function entriesOf(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  } catch {
    return `--blobs-dir "${dir}" could not be listed`;
  }
  if (entries.length === 0) return `--blobs-dir "${dir}" is empty`;
  const shown = entries.slice(0, ENTRIES_SHOWN).join(", ") + (entries.length > ENTRIES_SHOWN ? ` and ${entries.length - ENTRIES_SHOWN} more` : "");
  return `--blobs-dir holds ${shown}`;
}

function missingOriginals(modules: readonly ModuleRun[], answers: Readonly<Record<string, string>> | undefined, check: OriginalsCheck): MissingOriginals {
  for (const module of modules) {
    for (const migration of module.migrations) {
      const counts = migration.id === MISSING_ORIGINALS.migration ? migration.plan?.counts : undefined;
      const missing = counts?.missingOriginals ?? 0;
      if (counts === undefined || missing === 0) continue;
      const nowhere = (counts.copies ?? 0) === 0 && check.nowhere;
      const answer = answers?.[MISSING_ORIGINALS.question];
      if (answer !== undefined && (!nowhere || check.originalsGone)) {
        if (nowhere) return { note: `--originals-gone: none of the originals is under --blobs-dir "${check.blobsDir}", and the ${missing} item(s) of ${module.module} without one are answered "${answer}"` };
        continue;
      }
      const examples = (migration.plan?.notes ?? []).filter((n) => n.reason.endsWith(" is missing")).slice(0, 3).map((n) => `${n.item} (${n.reason})`);
      const head = `${missing} of ${counts.items ?? missing} item(s) of ${module.module} have no original under --blobs-dir "${check.blobsDir}", e.g. ${examples.join(", ")}`;
      if (nowhere && !check.originalsGone) return { stop: `${head}; none of the originals is there and no blob is under the media key prefix "${check.prefix}"; ${entriesOf(check.blobsDir)}. It most likely names another directory than the root of the copied blob store, such as one a level too deep, and then an answer to ${MISSING_ORIGINALS.question} does not cover this: name the root of the copy. When it is that root and every original is gone for good, run again with --originals-gone and an answer to ${MISSING_ORIGINALS.question} in an --answers file` };
      return { stop: `${head}; check that --blobs-dir is the copy of the directory the project's blobstore-filesystem root points at, and when the originals are gone for good, answer ${MISSING_ORIGINALS.question} in an --answers file: "keep" switches the items anyway and media.reconcile lists them, "trash" moves them to the trash` };
    }
  }
  return {};
}

async function holdsNothingUnder(blobs: Blobstore, prefix: string): Promise<boolean> {
  try {
    const listed = await blobs.list(prefix);
    return !isErr(listed) && listed.value.length === 0;
  } catch {
    return false;
  }
}

function originalsNowhere(modules: readonly ModuleRun[]): boolean {
  return modules.some((m) => m.migrations.some((r) => r.id === MISSING_ORIGINALS.migration && (r.plan?.counts.missingOriginals ?? 0) > 0 && (r.plan?.counts.copies ?? 0) === 0));
}

function svgCounts(modules: readonly ModuleRun[]): Record<string, number> | undefined {
  const layout = modules.flatMap((m) => m.migrations).find((m) => m.id === MISSING_ORIGINALS.migration);
  return (layout?.outcome ?? layout?.plan)?.counts;
}

function unknownSanitizer(modules: readonly ModuleRun[], sanitizer: ProjectStorages["svgSanitizer"], configProblem: string | undefined): string | undefined {
  const demoted = svgCounts(modules)?.svgDemoted ?? 0;
  if (sanitizer?.from !== undefined || demoted === 0) return undefined;
  const why = configProblem ?? (sanitizer?.unloaded === undefined ? undefined : `not every module entry could be loaded and checked offline: ${sanitizer.unloaded}`);
  if (why === undefined) return undefined;
  return `${demoted} 5.x SVG(s) would be kept as a .bin download, but ${why}, so migrate cannot tell whether a module of the project registers sanitize.svg and would clean them; make every module entry load (kestrel.config.ts with the environment it reads, and the project's dependencies installed) and run migrate again`;
}

function svgNotes(modules: readonly ModuleRun[], sanitizer: ProjectStorages["svgSanitizer"], configProblem: string | undefined): string[] {
  const counts = svgCounts(modules);
  if (counts === undefined) return [];
  if (sanitizer?.from !== undefined && (counts.svgSanitized ?? 0) > 0) return [`media/default cleans each 5.x SVG with the sanitize.svg step of ${sanitizer.from} and keeps it an image`];
  if (sanitizer?.from === undefined && (counts.svgDemoted ?? 0) > 0 && configProblem === undefined && sanitizer?.unloaded === undefined) {
    return ["no module of the project registers sanitize.svg, so every 5.x SVG is kept as a .bin download"];
  }
  return [];
}

function finished(run: ModuleRun): boolean {
  return run.state === "current" || run.state === "recorded" || run.state === "migrated" || run.state === "unrecorded";
}

/**
 * Brings the storage shape of a database copy and its filesystem blob tree to this release, in
 * place: the storage migrations of every module whose collections the database holds, taken from
 * the `./storage` export of the module package the project at `root` has installed, through the
 * project's own `persistence-sqlite` and `blobstore-filesystem`. Each migration writes new blobs
 * before rows switch to them and leaves the blobs it converted from in place, and a run after an
 * abort continues where it stopped. The instance lock of the database is neither taken nor honoured, so a
 * lock file another process left next to the copy does not stop the run. Nothing reaches the network.
 * Before it applies anything, a plan of the same run looks for items whose original is not under
 * `blobsDir`; unless `answers` answers `media-default:id-key-layout:missing-original`, such an item
 * stops the run with nothing converted, and a `plan` run names them in a note. When none of the
 * originals is found and `blobsDir` holds no blob under the media key prefix, the run names what
 * `blobsDir` holds and stops, unless `originalsGone` confirms that it is the root of the copied blob
 * store and `answers` answers that question; the answer then applies to every item. A database SQLite cannot open, such as one in a directory without free space or
 * write access, is reported as such and not as a failed `quick_check`.
 * Exit code `0` when every module is in this release's shape, `1` when a migration is still pending
 * or the stored data is too old or too new, `2` when the run could not start, an original is missing
 * without an answer, no original is found at all without `originalsGone`, or a migration failed or threw.
 */
export async function runMigrateStep(options: MigrateStepOptions): Promise<MigrateStepResult> {
  const { dbFile, blobsDir, root } = options;
  if (!existsSync(dbFile) || !statSync(dbFile).isFile()) return { exitCode: 2, error: `--db "${dbFile}" is not a file` };
  if (!existsSync(blobsDir) || !statSync(blobsDir).isDirectory()) return { exitCode: 2, error: `--blobs-dir "${blobsDir}" is not a directory` };
  const checked = quickCheck(dbFile);
  if (!checked.ok && checked.unreadable) return { exitCode: 2, error: `"${dbFile}" could not be opened (${checked.reason}); SQLite writes its -wal and -shm files next to the database, so give its directory free space and write access, then run migrate again; nothing was converted` };
  if (!checked.ok) return { exitCode: 2, error: `"${dbFile}" did not pass PRAGMA quick_check (${checked.reason}); take a consistent copy ("sqlite3 <db> .backup <copy>", a replication snapshot) and run migrate on that` };
  const persistence = await persistenceOf(root);
  if (persistence === undefined) return { exitCode: 2, error: "the project's own @michaelthielemann/kestrel-persistence-sqlite could not be resolved; install the project's dependencies first" };
  const filesystem = await blobstoreOf(root);
  if (filesystem === undefined) return { exitCode: 2, error: "the project's own @michaelthielemann/kestrel-blobstore-filesystem could not be resolved; install the project's dependencies first" };
  const { storages, unresolved, configFrom, configProblem, mediaPrefix, svgSanitizer } = await projectStorages(root, dbFile, { sanitizeSvg: true, ...(options.plugins === undefined ? {} : { plugins: options.plugins }), ...(options.mediaPrefix === undefined ? {} : { mediaPrefix: options.mediaPrefix }) });
  if (unresolved.length > 0) {
    return { exitCode: 2, error: unresolved.map((u) => `the database holds ${u.collections.join(", ")}, but ${u.package}/storage could not be loaded from the project; install the project's 6.x dependencies first`).join("; ") };
  }
  if (configProblem !== undefined && options.mediaPrefix === undefined && storages.length > 0) {
    return { exitCode: 2, error: `${configProblem}; migrate needs the module config for the media key prefix, so make kestrel.config.ts load (with the environment it reads) or name the prefix with --media-prefix <prefix>; nothing was converted` };
  }
  if (svgSanitizer?.broken !== undefined) {
    return { exitCode: 2, error: `${svgSanitizer.from ?? "the module"} registers sanitize.svg, but ${svgSanitizer.broken}; nothing was converted` };
  }
  const convertsTo = mediaPrefix ?? "media/";
  const notes: string[] = [];
  if (mediaPrefix !== undefined) notes.push(`media/default converts to the key prefix "${mediaPrefix}" from ${configFrom}`);
  if (existsSync(`${dbFile}.instance`)) notes.push(`${dbFile}.instance exists: migrate neither takes nor honours the instance lock, so make sure no process uses this copy`);
  const opened = persistence.createPersistenceSqlite({ file: dbFile }, { logger: silentLogger });
  try {
    const stores: { db: Persistence; blobs: Blobstore } = { db: opened, blobs: filesystem.createBlobstoreFilesystem({ root: blobsDir }) };
    const { db, blobs } = options.wrap === undefined ? stores : options.wrap(stores);
    const shared = { storages, db, blobs, blobWrites: true, ...(options.answers === undefined ? {} : { answers: options.answers }), ...(options.now === undefined ? {} : { now: options.now }) };
    if (options.plan !== true) {
      const preview = await guarded(() => runShapeMigrations({ ...shared, apply: false }));
      if (isErr(preview)) return { exitCode: 2, error: `${preview.error}; nothing was converted` };
      const unknown = unknownSanitizer(preview.value.modules, svgSanitizer, configProblem);
      if (unknown !== undefined) return { exitCode: 2, error: `${unknown}; nothing was converted` };
      const nowhere = originalsNowhere(preview.value.modules) && (await holdsNothingUnder(stores.blobs, convertsTo));
      const checked = missingOriginals(preview.value.modules, options.answers, { blobsDir, prefix: convertsTo, nowhere, originalsGone: options.originalsGone === true });
      if (checked.stop !== undefined) return { exitCode: 2, error: `${checked.stop}; nothing was converted` };
      if (checked.note !== undefined) notes.push(checked.note);
    }
    const run = await guarded(() => runShapeMigrations({ ...shared, apply: options.plan !== true }));
    if (isErr(run)) return { exitCode: 2, error: `${run.error}; nothing that ran before this is undone, so running migrate again continues from here` };
    if (options.plan === true) {
      const nowhere = originalsNowhere(run.value.modules) && (await holdsNothingUnder(stores.blobs, convertsTo));
      const checked = missingOriginals(run.value.modules, options.answers, { blobsDir, prefix: convertsTo, nowhere, originalsGone: options.originalsGone === true });
      if (checked.stop !== undefined) notes.push(`${checked.stop}; migrate without --plan refuses to convert anything until then`);
      if (checked.note !== undefined) notes.push(checked.note);
      const unknown = unknownSanitizer(run.value.modules, svgSanitizer, configProblem);
      if (unknown !== undefined) notes.push(`${unknown}; migrate without --plan refuses to convert anything until then`);
    }
    notes.push(...svgNotes(run.value.modules, svgSanitizer, configProblem));
    const report: MigrateReport = { schema: 1, tool: { name: "kestrel-upgrade", version: toolVersion() }, command: "migrate", db: dbFile, blobsDir, applied: options.plan !== true, modules: run.value.modules, notes };
    return { exitCode: run.value.modules.every(finished) ? 0 : 1, report };
  } finally {
    opened.close();
  }
}

function countsText(counts: Record<string, number>): string {
  const parts = Object.entries(counts).filter(([, n]) => n !== 0).map(([name, n]) => `${name} ${n}`);
  return parts.length === 0 ? "nothing to do" : parts.join(", ");
}

/** The human-readable form of a {@link MigrateReport}. */
export function renderMigrate(report: MigrateReport): string {
  const lines: string[] = [];
  for (const note of report.notes) lines.push(`note: ${note}`);
  if (report.modules.length === 0) lines.push("no module with storage migrations holds data in this database");
  for (const module of report.modules) {
    lines.push(`${module.module}: ${module.state} (stored ${module.stored ?? "none"}, this release ${module.version})`);
    for (const migration of module.migrations) {
      const head = `  ${migration.id}: ${migration.state}${migration.blocked === undefined ? "" : ` (${migration.blocked})`}, ${migration.detected.pending} item(s) found`;
      lines.push(head);
      if (migration.outcome !== undefined) lines.push(`    did: ${countsText(migration.outcome.counts)}`);
      else if (migration.plan !== undefined) lines.push(`    would: ${countsText(migration.plan.counts)}`);
      for (const note of (migration.outcome ?? migration.plan)?.notes ?? []) lines.push(`    ${note.item}: ${note.reason}`);
      if (migration.unanswered.length > 0) lines.push(`    needs an answer: ${migration.unanswered.join(", ")}`);
    }
  }
  if (!report.applied) lines.push("planned only (--plan): no row or blob was converted");
  return lines.join("\n");
}
