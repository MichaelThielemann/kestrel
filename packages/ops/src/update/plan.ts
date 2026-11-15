import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure, err, isErr, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { runShapeMigrations, type BlobOps, type ModuleRun, type ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { OpsError } from "../errors.ts";
import { blobstoreOf } from "../replica.ts";
import type { ObjectStore } from "../store.ts";
import { listUpdateRuns, readUpdateRun } from "./journal.ts";
import { releaseStorages } from "./storages.ts";
import type { PlannedStorageMigration, UpdateContext, UpdatePlan, VersionSet } from "./types.ts";

/** The packages a version change is decided on: every installed package whose name starts with this. */
export const VERSIONED_PACKAGES = "@michaelthielemann/kestrel";

/** The collection the content migrations of a database are recorded in. */
export const CONTENT_LEDGER = "content_migrations";

const PERSISTENCE_IMPL = "@michaelthielemann/kestrel-persistence-sqlite/impl";

/** The versions of `packages` whose name starts with {@link VERSIONED_PACKAGES}, sorted by name. */
export function versionSet(packages: Readonly<Record<string, string>>): VersionSet {
  return Object.fromEntries(
    Object.entries(packages)
      .filter(([name]) => name.startsWith(VERSIONED_PACKAGES))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** True when both version sets name the same packages with the same versions. */
export function sameVersions(a: Readonly<Record<string, string>> | null, b: Readonly<Record<string, string>>): boolean {
  if (a === null) return false;
  const left = Object.entries(versionSet(a));
  const right = Object.entries(versionSet(b));
  return left.length === right.length && left.every(([name, version], i) => right[i]?.[0] === name && right[i]?.[1] === version);
}

/**
 * The versions the app runs: those the target reports when it reports any of {@link VERSIONED_PACKAGES}, otherwise
 * the `versions.to` of the newest verified deploy of this environment, or null when neither exists, which counts as a
 * version change.
 */
export async function runningVersions(ctx: UpdateContext): Promise<VersionSet | null> {
  const reported = versionSet((await ctx.target.describe()).packages);
  if (Object.keys(reported).length > 0) return reported;
  const deploys = (await listUpdateRuns(ctx, ctx.envName)).filter((r) => r.command === "update deploy" && r.runId !== ctx.run.id);
  for (const entry of deploys.reverse()) {
    const run = await readUpdateRun(ctx, entry.runId);
    if ((run.state === "verified" || run.state === "accepted" || run.state === "cleaned") && run.versions !== null) return versionSet(run.versions.to);
  }
  return null;
}

/** The content-migration ids the host contributes for the release (`contentMigrations` of its facts), sorted. */
export function releaseContentMigrations(ctx: Pick<UpdateContext, "host">): string[] {
  const listed: unknown = Reflect.get(ctx.host, "contentMigrations");
  return Array.isArray(listed) ? listed.filter((id): id is string => typeof id === "string").sort() : [];
}

/** The ids the content-migration ledger of `database` holds; none when the database has no ledger. */
export function appliedContentMigrations(database: string): Set<string> {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(CONTENT_LEDGER);
    if (exists === undefined) return new Set();
    return new Set(db.prepare(`SELECT "id" FROM "${CONTENT_LEDGER}"`).all().map((row) => String(row.id)));
  } finally {
    db.close();
  }
}

interface ClosablePersistence extends Persistence {
  close(): void;
}

function isPersistenceModule(value: unknown): value is { createPersistenceSqlite(config: { file: string }): ClosablePersistence } {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "createPersistenceSqlite") === "function";
}

function resolveFrom(base: string, specifier: string): string | null {
  try {
    return createRequire(join(base, "package.json")).resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Opens `file` with the persistence-sqlite of the release, found from the release directory, the working directory
 * or kestrel-ops itself, in that order; refuses with exit 2 when none of them has it installed.
 */
export async function openDatabase(ctx: Pick<UpdateContext, "release">, file: string): Promise<ClosablePersistence> {
  const bases = [ctx.release.dir, process.cwd(), dirname(fileURLToPath(import.meta.url))];
  const found = bases.map((base) => resolveFrom(base, PERSISTENCE_IMPL)).find((path): path is string => path !== null);
  if (found === undefined) throw new OpsError(`${PERSISTENCE_IMPL} is not installed for the release in ${ctx.release.dir}; the plan needs it to read a database copy`, 2, PERSISTENCE_IMPL);
  const mod: unknown = await import(pathToFileURL(found).href);
  if (!isPersistenceModule(mod)) throw new OpsError(`${PERSISTENCE_IMPL} offers no createPersistenceSqlite`, 2, PERSISTENCE_IMPL);
  return mod.createPersistenceSqlite({ file });
}

/** A blob store over `store` that reads and refuses every write, for detecting and planning without changing a blob. */
export function readOnlyBlobs(store: ObjectStore): { blobs: Blobstore; blobOps: BlobOps } {
  const reads = blobstoreOf(store);
  const refused = async () => err(failure("TRANSIENT", "the plan writes no blob"));
  return {
    blobs: { ...reads, put: refused, remove: refused, move: refused },
    blobOps: {
      copy: refused,
      head: async (key) => {
        try {
          const info = await store.head(key);
          return ok(info === null ? null : { size: info.size, sha256: null });
        } catch (cause) {
          return err(failure("TRANSIENT", `head ${key} failed`, { cause }));
        }
      },
    },
  };
}

/** The storage migrations a run report leaves pending, without cleanup migrations, which no deploy runs. */
export function pendingStorage(modules: readonly ModuleRun[]): PlannedStorageMigration[] {
  return modules.flatMap((module) =>
    module.migrations.filter((m) => m.state === "pending" && m.kind !== "cleanup").map((m) => ({ module: module.module, id: m.id, kind: m.kind, blobWrites: m.blobWrites, pending: m.detected.pending })),
  );
}

function questionsOf(storages: readonly ModuleStorage[], planned: readonly PlannedStorageMigration[]): string[] {
  const ids = new Set(planned.map((m) => m.id));
  return storages.flatMap((s) => s.migrations.filter((m) => ids.has(m.id)).flatMap((m) => (m.questions ?? []).map((q) => q.id))).sort();
}

/**
 * Plans the update on `database`, a copy of the newest replica generation: the storage-shape migrations of the
 * release's modules that detect their old form (detect and plan only, no row or blob is written), and the content
 * migrations of the release that the copy's ledger does not hold. `versions` is the change from
 * {@link runningVersions} to the release's {@link versionSet}.
 */
export async function computePlan(ctx: UpdateContext, database: string): Promise<UpdatePlan> {
  const from = await runningVersions(ctx);
  const to = versionSet(ctx.release.versions);
  const storages = await releaseStorages(ctx);
  let storage: PlannedStorageMigration[] = [];
  if (storages.length > 0) {
    const db = await openDatabase(ctx, database);
    try {
      const report = await runShapeMigrations({ storages, db, ...readOnlyBlobs(ctx.app), apply: false, blobWrites: false, answers: ctx.answers.answers, now: ctx.clock });
      if (isErr(report)) throw new OpsError(`planning the storage migrations failed: ${report.error.message}`, 1, "plan");
      const refused = report.value.modules.find((m) => m.state === "too-old" || m.state === "too-new");
      if (refused !== undefined) throw new OpsError(`the stored data of ${refused.module} is ${refused.state === "too-old" ? "older" : "newer"} than this release converts (stored ${refused.stored ?? "none"}, release ${refused.version})`, 1, refused.module);
      storage = pendingStorage(report.value.modules);
    } finally {
      db.close();
    }
  }
  const applied = appliedContentMigrations(database);
  const content = releaseContentMigrations(ctx).filter((id) => !applied.has(id));
  return { versions: { from, to }, storage, content, questions: questionsOf(storages, storage) };
}

/**
 * The sha256 (hex) of the canonical JSON of the plan's `versions.to`, the sorted ids of its storage migrations with
 * their `kind` and `blobWrites`, and the sorted ids of its content migrations; counts and questions are left out.
 */
export function planHash(plan: UpdatePlan): string {
  const canonical = {
    to: versionSet(plan.versions.to),
    storage: plan.storage.map((m) => ({ id: m.id, kind: m.kind, blobWrites: m.blobWrites })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    content: [...plan.content].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** True when the plan changes versions or has a storage migration pending, so a deploy needs a matching receipt. */
export function needsReceipt(plan: UpdatePlan): boolean {
  return !sameVersions(plan.versions.from, plan.versions.to) || plan.storage.length > 0;
}
