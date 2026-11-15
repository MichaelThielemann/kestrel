import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { silentLogger } from "@michaelthielemann/kestrel/logger";
import type { Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { failure, err, isErr, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { compareVersions, runShapeMigrations, type BlobOps, type ModuleRun, type ModuleStorage } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import type { Persistence } from "@michaelthielemann/kestrel-contracts/persistence";
import { PERSISTENCE_PACKAGE, SANITIZE_SVG_PACKAGE } from "../bundle.ts";
import { REPLICATION_PACKAGE } from "../context.ts";
import { OpsError } from "../errors.ts";
import { refuseUnfinishedPlacement } from "../placements.ts";
import { blobstoreOf, buildDatabase, completeGeneration, stableGenerations } from "../replica.ts";
import type { ObjectStore } from "../store.ts";
import { ledgerIds } from "./contentMigrations.ts";
import { listUpdateRuns, readUpdateRun } from "./journal.ts";
import { importReleasePackage, releaseStorages, releaseSvgSanitizer } from "./storages.ts";
import type { PlannedStorageMigration, UpdateContext, UpdatePlan, VersionSet } from "./types.ts";

/** The packages a version change is decided on: every installed package whose name starts with this. */
export const VERSIONED_PACKAGES = "@michaelthielemann/kestrel";

/** Rebuilds the newest replica generation, as listed now, into `file` and resolves to it; refuses with exit 1 for an empty replica or an unfinished placement. */
export async function replicaCopy(ctx: UpdateContext, file: string): Promise<string> {
  const prefix = ctx.env.app.replicaPrefix;
  const gens = await stableGenerations(ctx.app, prefix, ctx.poll);
  const newest = gens.at(-1);
  if (newest === undefined) throw new OpsError(`the replica under ${prefix} has no generation`, 1, prefix);
  await refuseUnfinishedPlacement(ctx, gens);
  await buildDatabase(ctx.app, prefix, await completeGeneration(ctx.app, prefix, newest, ctx.poll), file);
  return file;
}

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

function within(dir: string, base: string): boolean {
  const path = relative(resolve(base), resolve(dir));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function readsRelease(release: UpdateContext["release"], from: string): boolean {
  const project = resolve(release.projectDir);
  return resolve(from) === project || (resolve(release.dir) !== project && within(from, release.dir));
}

/**
 * The packages the target reports for the running app, or none when it read them from the installation of the release
 * this command deploys (`TargetFacts.packagesFrom` is the release's project directory, or lies inside a release
 * directory other than the project), since those are the new release's versions, not the running ones.
 */
export async function reportedVersions(ctx: Pick<UpdateContext, "target" | "release">): Promise<Record<string, string>> {
  const facts = await ctx.target.describe();
  return facts.packagesFrom !== undefined && readsRelease(ctx.release, facts.packagesFrom) ? {} : facts.packages;
}

/**
 * The versions the app runs: the `versions.to` of the newest verified deploy of this environment, which is what the
 * tool put there; before the first one, those the target reports ({@link reportedVersions}) when it reports any of
 * {@link VERSIONED_PACKAGES}; null when neither exists, which counts as a version change. A deploy falls back to the
 * `versions.from` of the receipt its gate matched.
 */
export async function runningVersions(ctx: UpdateContext): Promise<VersionSet | null> {
  const deploys = (await listUpdateRuns(ctx, ctx.envName)).filter((r) => r.command === "update deploy" && r.runId !== ctx.run.id);
  for (const entry of deploys.reverse()) {
    const run = await readUpdateRun(ctx, entry.runId);
    if ((run.state === "verified" || run.state === "accepted" || run.state === "cleaned") && run.versions !== null) return versionSet(run.versions.to);
  }
  const reported = versionSet(await reportedVersions(ctx));
  return Object.keys(reported).length > 0 ? reported : null;
}

/** The replication runtime version a set of versions names, or the core's of the same release when it names none. */
export function runtimeOf(versions: Readonly<Record<string, string>> | null): string | null {
  return versions?.[REPLICATION_PACKAGE] ?? versions?.["@michaelthielemann/kestrel"] ?? null;
}

/** The content-migration ids the host contributes for the release (`contentMigrations` of its facts), sorted. */
export function releaseContentMigrations(ctx: Pick<UpdateContext, "host">): string[] {
  return [...(ctx.host.contentMigrations ?? [])].sort();
}

/** The ids the content-migration ledger of `database` holds; none when the database has no ledger. */
export function appliedContentMigrations(database: string): Set<string> {
  return new Set(ledgerIds(database));
}

/** A database opened through the persistence package of the release. */
export interface ClosablePersistence extends Persistence {
  close(): void;
}

/**
 * Opens `file` with the persistence package of the release, found as {@link importReleasePackage} finds it: from the
 * release directory, or in a deploy job from the bundle that carries kestrel-ops; refuses with exit 2 when neither
 * has it installed.
 */
export async function openDatabase(ctx: Pick<UpdateContext, "release">, file: string): Promise<ClosablePersistence> {
  const mod = await importReleasePackage(ctx, PERSISTENCE_PACKAGE, "./impl");
  const create: unknown = typeof mod === "object" && mod !== null ? Reflect.get(mod, "createPersistenceSqlite") : undefined;
  if (typeof create !== "function") throw new OpsError(`${PERSISTENCE_PACKAGE} is not installed for the release in ${ctx.release.dir}; an update needs it to open a database copy`, 2, PERSISTENCE_PACKAGE);
  return boundaryCast<(config: { file: string }, deps: { logger: unknown }) => ClosablePersistence>(create, "host")({ file }, { logger: silentLogger });
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
    module.migrations.filter((m) => m.state === "pending" && m.kind !== "cleanup").map((m) => ({ module: module.module, id: m.id, kind: m.kind, blobWrites: m.blobWrites, pending: m.detected.pending, introducedIn: m.introducedIn, stored: module.stored })),
  );
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)/;

function writtenMajor(pending: readonly PlannedStorageMigration[], storage: ModuleStorage | undefined): number | null {
  const oldest = pending.map((m) => m.introducedIn).sort(compareVersions)[0];
  const lowest = VERSION.exec(pending[0]?.stored ?? storage?.convertsFrom ?? "");
  const before = VERSION.exec(oldest ?? "");
  if (lowest === null || before === null) return null;
  const major = Number(lowest[1]);
  const newest = before[2] === "0" && before[3] === "0" ? Number(before[1]) - 1 : Number(before[1]);
  return major === newest ? major : null;
}

/**
 * The major of the release that wrote the stored data the plan's pending storage migrations convert, or null when the
 * plan has none or the data may come from more than one major. A module's data was written by a release from its
 * storage version row (`stored`), or without one from the oldest version the release converts (`convertsFrom` of its
 * entry in `storages`), up to the release before its oldest pending migration's `introducedIn`, since a release that
 * runs keeps no data in a form its own migrations convert. Each module with a pending migration must name one major,
 * and all of them the same.
 */
export function sourceMajor(plan: Pick<UpdatePlan, "storage">, storages: readonly ModuleStorage[]): number | null {
  const majors = new Set<number | null>();
  for (const module of new Set(plan.storage.map((m) => m.module))) {
    majors.add(writtenMajor(plan.storage.filter((m) => m.module === module), storages.find((s) => s.module === module)));
  }
  const [major] = [...majors];
  return majors.size === 1 && major !== undefined ? major : null;
}

/**
 * Refuses with exit 2 when the planned or previewed storage migrations in `modules` would keep stored SVGs as
 * downloads (`svgDemoted`) because the release has no SVG sanitizer installed to clean them with.
 */
export async function refuseUnsanitizedSvgs(ctx: Pick<UpdateContext, "release">, storages: readonly ModuleStorage[], modules: readonly ModuleRun[]): Promise<void> {
  const demoted = modules.flatMap((m) => m.migrations).reduce((n, r) => n + (r.plan?.counts.svgDemoted ?? 0), 0);
  if (demoted > 0 && storages.some((s) => s.module === "media/default") && (await releaseSvgSanitizer(ctx)) === null) {
    throw new OpsError(`${demoted} stored SVG(s) would be kept as downloads, because the release has no ${SANITIZE_SVG_PACKAGE} to clean them with; install it in the project and bundle again`, 2, "storage-migrations");
  }
}

function questionsOf(storages: readonly ModuleStorage[], planned: readonly PlannedStorageMigration[]): string[] {
  const ids = new Set(planned.map((m) => m.id));
  return storages.flatMap((s) => s.migrations.filter((m) => ids.has(m.id)).flatMap((m) => (m.questions ?? []).map((q) => q.id))).sort();
}

/**
 * Plans the update on `database`, a copy of the newest replica generation: the storage-shape migrations of the
 * release's modules that detect their old form (detect and plan only, no row or blob is written), and the content
 * migrations of the release that the copy's ledger does not hold. `versions` is the change from
 * {@link runningVersions} to the release's {@link versionSet}. Refuses with exit 2 through
 * {@link refuseUnsanitizedSvgs}, so prepare and the gate of a deploy refuse such a release before anything changes.
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
      await refuseUnsanitizedSvgs(ctx, storages, report.value.modules);
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

const kestrelMajor = (versions: Readonly<Record<string, string>>): string | null => (versions["@michaelthielemann/kestrel"] ?? versions["@michaelthielemann/kestrel-replication-sqlite"])?.split(".")[0] ?? null;

/**
 * Whether a deploy of `plan` pins its cutover backup until `update cleanup`: when the major of Kestrel changes or the
 * running versions are unknown, or when a storage migration is pending. Otherwise the retention of `cutover` backups
 * keeps it.
 */
export function pinsCutover(plan: UpdatePlan): boolean {
  if (plan.storage.length > 0 || plan.versions.from === null) return true;
  const from = kestrelMajor(plan.versions.from);
  return from === null || from !== kestrelMajor(plan.versions.to);
}
