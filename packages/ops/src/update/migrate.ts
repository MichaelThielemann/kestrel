import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { failure } from "@michaelthielemann/kestrel/errors";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import type { Blobstore, BlobstoreError } from "@michaelthielemann/kestrel-contracts/blobstore";
import { runShapeMigrations, STORAGE_VERSIONS, type BlobOps, type ModuleRun, type ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { readManifest } from "../backup.ts";
import { messageOf } from "../context.ts";
import { OpsError } from "../errors.ts";
import { fixedText } from "../redact.ts";
import { keys } from "../layout.ts";
import { sha256, sha256File, tables } from "../sqlite.ts";
import type { ObjectStore } from "../store.ts";
import { CONTENT_LEDGER, runContentMigrations } from "./contentMigrations.ts";
import { openDatabase, refuseUnsanitizedSvgs } from "./plan.ts";
import { releaseStorages } from "./storages.ts";
import type { MigrateInput, MigrateResult, UpdateContext } from "./types.ts";

const PHASE = "contentMigrations";
const FINISHED = new Set<ModuleRun["state"]>(["current", "recorded", "unrecorded", "migrated"]);

const refused = (message: string): Result<never, BlobstoreError> => err(failure("TRANSIENT", `expand-only: ${message}`));

async function guarded<T>(what: string, run: () => Promise<T>): Promise<Result<T, BlobstoreError>> {
  try {
    return ok(await run());
  } catch (cause) {
    return err(failure("TRANSIENT", `${what} failed: ${messageOf(cause)}`, { cause }));
  }
}

/**
 * The app's store as the storage migrations of an update reach it: they read every key, and write only keys that do
 * not exist yet, copies server-side; a write over an existing key, a removal and a move are refused, so the old
 * release's keys stay as they are.
 */
export function expandOnlyStore(store: ObjectStore): { blobs: Blobstore; blobOps: BlobOps } {
  const fresh = async (key: string): Promise<Result<void, BlobstoreError>> => {
    const head = await guarded(`head ${key}`, () => store.head(key));
    if (isErr(head)) return head;
    return head.value === null ? ok(undefined) : refused(`${key} exists and is never overwritten`);
  };
  const blobs: Blobstore = {
    put: async (key, data, options) => {
      const free = await fresh(key);
      if (isErr(free)) return free;
      return guarded(`put ${key}`, () => store.put(key, data, options?.contentType === undefined ? {} : { contentType: options.contentType }));
    },
    get: (key) => guarded(`get ${key}`, () => store.get(key)),
    remove: async (key) => refused(`removing ${key} is refused`),
    move: async (from) => refused(`moving ${from} is refused`),
    list: (prefix) => guarded(`list ${prefix}`, async () => (await store.list(prefix)).map((info) => ({ key: info.key, size: info.size }))),
  };
  const blobOps: BlobOps = {
    copy: async (from, to) => {
      const free = await fresh(to);
      if (isErr(free)) return free;
      const source = await guarded(`head ${from}`, () => store.head(from));
      if (isErr(source)) return source;
      if (source.value === null) return err(failure("NOT_FOUND", `${from} does not exist`));
      return guarded(`copy ${from}`, () => store.copy(from, to, { ifMatch: source.value?.etag ?? "" }));
    },
    head: async (key) => {
      const head = await guarded(`head ${key}`, () => store.head(key));
      if (isErr(head)) return head;
      return ok(head.value === null ? null : { size: head.value.size, sha256: null });
    },
  };
  return { blobs, blobOps };
}

function settle(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("PRAGMA journal_mode = DELETE");
  } finally {
    db.close();
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(file + suffix, { force: true });
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * Tables whose rows differ between `before` and `after`. A column `after` added stays out of the comparison while it
 * holds only nulls, so a collection whose schema a migration prepared without changing a row counts as unchanged.
 */
export function changedTables(before: string, after: string): string[] {
  const db = new DatabaseSync(after, { readOnly: true });
  try {
    db.prepare(`ATTACH DATABASE ? AS "before"`).run(before);
    const old = new Set(tables(db, "before"));
    const now = new Set(tables(db, "main"));
    const changed: string[] = [];
    for (const table of [...new Set([...old, ...now])].sort()) {
      if (!old.has(table) || !now.has(table)) {
        changed.push(table);
        continue;
      }
      const columnsOf = (schema: string): string[] => boundaryCast<Array<{ name: string }>>(db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all(), "host").map((c) => c.name);
      const oldColumns = columnsOf("before");
      const newColumns = new Set(columnsOf("main"));
      const count = (sql: string): number => Number(Object.values(boundaryCast<Record<string, unknown>>(db.prepare(sql).get(), "host"))[0]);
      const t = quote(table);
      if (oldColumns.some((c) => !newColumns.has(c))) {
        changed.push(table);
        continue;
      }
      const list = oldColumns.map(quote).join(", ");
      const added = [...newColumns].filter((c) => !oldColumns.includes(c));
      const differs =
        count(`SELECT count(*) FROM "before".${t}`) !== count(`SELECT count(*) FROM main.${t}`) ||
        count(`SELECT count(*) FROM (SELECT ${list} FROM main.${t} EXCEPT SELECT ${list} FROM "before".${t})`) > 0 ||
        count(`SELECT count(*) FROM (SELECT ${list} FROM "before".${t} EXCEPT SELECT ${list} FROM main.${t})`) > 0 ||
        added.some((c) => count(`SELECT count(*) FROM main.${t} WHERE ${quote(c)} IS NOT NULL`) > 0);
      if (differs) changed.push(table);
    }
    return changed;
  } finally {
    db.close();
  }
}

async function shapeRun(ctx: UpdateContext, storages: readonly ModuleStorage[], file: string, apply: boolean): Promise<ModuleRun[]> {
  if (storages.length === 0) return [];
  const db = await openDatabase(ctx, file);
  try {
    const { blobs, blobOps } = expandOnlyStore(ctx.app);
    const answers = ctx.answers.answers;
    const report = await runShapeMigrations({ storages, db, blobs, blobOps, apply, blobWrites: true, answers, now: ctx.clock });
    if (isErr(report)) throw new OpsError(`the storage migrations of the release failed on the copy: ${report.error.message}; nothing outside the copy was removed or overwritten, so the migration starts again from the cutover backup`, 1, "storage-migrations");
    return report.value.modules;
  } finally {
    db.close();
  }
}

const pendingIds = (modules: readonly ModuleRun[]): string[] => modules.flatMap((m) => m.migrations.filter((r) => r.state === "pending" && r.blocked !== "cleanup").map((r) => r.id));

/**
 * Migrates a copy of the cutover backup's database (phase `contentMigrations`, steps `copy`, `storage-migrations`,
 * `content-migrations`, `migrate-check`): always starts from a fresh download of the cutover `db.sqlite`, so a run
 * killed in the middle of a migration that is not idempotent starts again from the same state; applies the planned
 * storage-shape migrations with blob writes going expand-only into the app's store through server-side copies while
 * the app is stopped; applies the content migrations through `runContentMigrations`; then checks that no storage
 * migration is pending and that only the content-migration ledger and migrated collections changed. Refuses a
 * migration the plan does not name.
 */
export async function migrateCopy(ctx: UpdateContext, input: MigrateInput): Promise<MigrateResult> {
  const record = (step: string, state: "started" | "done", data: Record<string, unknown> = {}): Promise<void> => ctx.journal.record(step, state, { phase: PHASE, ...data });
  const { outFile } = input;
  const cutover = `${outFile}.cutover`;

  await record("copy", "started", { backupId: input.cutoverBackup });
  const manifest = await readManifest(ctx, input.cutoverBackup);
  if (manifest === null) throw new OpsError(`the cutover backup ${input.cutoverBackup} has no manifest`, 1, input.cutoverBackup);
  if (manifest.db === null) throw new OpsError(`the cutover backup ${input.cutoverBackup} holds no database`, 1, input.cutoverBackup);
  const data = await ctx.backups.get(ctx.location + keys.db(manifest.id));
  if (data === null || sha256(data) !== manifest.db.sha256) throw new OpsError(`the cutover backup ${input.cutoverBackup}: db.sqlite is missing or differs from its manifest`, 1, "db.sqlite");
  mkdirSync(dirname(outFile), { recursive: true });
  for (const file of [outFile, cutover]) for (const suffix of ["", "-wal", "-shm", "-journal", ".instance"]) rmSync(file + suffix, { force: true });
  writeFileSync(cutover, data, { mode: 0o600 });
  copyFileSync(cutover, outFile);
  await record("copy", "done", { backupId: manifest.id, sha256: manifest.db.sha256 });

  await record("storage-migrations", "started", {});
  const storages = await releaseStorages(ctx);
  const planned = new Set(input.plan.storage.map((m) => m.id));
  const preview = await shapeRun(ctx, storages, outFile, false);
  const unplanned = pendingIds(preview).filter((id) => !planned.has(id));
  if (unplanned.length > 0) throw new OpsError(fixedText`the copy needs storage migrations the plan does not name: ${unplanned.join(", ")}; run update prepare again`, 1, "storage-migrations");
  await refuseUnsanitizedSvgs(ctx, storages, preview);
  const storage = await shapeRun(ctx, storages, outFile, true);
  const unfinished = storage.filter((m) => !FINISHED.has(m.state));
  if (unfinished.length > 0) throw new OpsError(`storage migrations still wait on the copy: ${unfinished.map((m) => `${m.module} ${m.state}`).join(", ")}`, 1, "storage-migrations");
  settle(outFile);
  const afterStorage = `${outFile}.storage`;
  copyFileSync(outFile, afterStorage);
  await record("storage-migrations", "done", { modules: storage.map((m) => ({ module: m.module, state: m.state, applied: m.migrations.filter((r) => r.state === "applied").map((r) => r.id) })) });

  await record("content-migrations", "started", { expected: input.plan.content });
  const content = await runContentMigrations(ctx, { database: outFile, blobsDir: ctx.workspace.path("local-blobs"), expected: input.plan.content });
  settle(outFile);
  await record("content-migrations", "done", { ran: content.ran, applied: content.applied, bootMs: content.bootMs });

  await record("migrate-check", "started", {});
  const still = pendingIds(await shapeRun(ctx, storages, outFile, false));
  settle(outFile);
  if (still.length > 0) throw new OpsError(`storage migrations are still pending on the migrated copy: ${still.join(", ")}`, 1, "migrate-check");
  const byStorage = new Set(changedTables(cutover, afterStorage));
  const byBoot = changedTables(afterStorage, outFile);
  const stray = byBoot.filter((table) => table !== CONTENT_LEDGER && content.applied.length === 0);
  const strayStorage = [...byStorage].filter((table) => table !== STORAGE_VERSIONS && !storage.some((m) => m.state === "migrated"));
  if (stray.length > 0 || strayStorage.length > 0) throw new OpsError(`the migration changed ${[...strayStorage, ...stray].join(", ")} although no migration converted it`, 1, "migrate-check");
  const changed = changedTables(cutover, outFile);
  const sha = sha256File(outFile);
  for (const file of [cutover, afterStorage]) rmSync(file, { force: true });
  await record("migrate-check", "done", { sha256: sha, changedTables: changed });
  return { sha256: sha, storage, content: content.applied, changedTables: changed };
}
