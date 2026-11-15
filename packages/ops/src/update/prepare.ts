import { copyFileSync, mkdirSync } from "node:fs";
import { failure, err, isErr, ok } from "@michaelthielemann/kestrel-contracts/errors";
import { runShapeMigrations, type BlobOps } from "@michaelthielemann/kestrel-contracts/helpers/shape-migrations";
import { messageOf } from "../context.ts";
import { OpsError } from "../errors.ts";
import { MemoryBucket, memoryStore } from "../memoryStore.ts";
import { blobstoreOf, MAX_SKEW_MS } from "../replica.ts";
import { serverClock } from "../serverTime.ts";
import { integrityCheck, referencedBlobs, sha256 } from "../sqlite.ts";
import { listMap, type ObjectInfo, type ObjectStore } from "../store.ts";
import { runContentMigrations } from "./contentMigrations.ts";
import { updateKeys } from "./layout.ts";
import { UNCHECKED_READINESS } from "./gate.ts";
import { computePlan, openDatabase, pendingStorage, planHash, replicaCopy } from "./plan.ts";
import { releaseStorages } from "./storages.ts";
import { UPDATE_EXIT, type Rehearsal, type RehearsalCheck, type UpdateContext, type UpdateOutcome, type UpdatePlan, type UpdateReceipt } from "./types.ts";
import { outcomeOf } from "./verify.ts";

/** Options of {@link prepare}. */
export interface PrepareOptions {
  /** Download every original for the rehearsal instead of the ones the migrations touch and a sample. */
  fullMedia: boolean;
}

/** What {@link prepare} wrote. */
export interface PrepareResult {
  receipt: UpdateReceipt;
  outcome: UpdateOutcome;
}

/** How many referenced originals the rehearsal reads back without `fullMedia`. */
export const REHEARSAL_SAMPLE = 25;

const record = (ctx: UpdateContext, step: string, state: "started" | "done" | "failed", data: Record<string, unknown> = {}): Promise<void> => ctx.journal.record(step, state, { phase: "prepare", ...data });

/**
 * A store that reads through to `base` and keeps every write in memory, so a rehearsed migration never changes a key
 * of the app's store. A copy of a key the overlay does not hold is kept as a reference to the source, so a migration
 * that copies every original holds none of their bytes.
 */
export function overlayStore(base: ObjectStore): ObjectStore {
  const overlay = memoryStore(new MemoryBucket("rehearsal"));
  const removed = new Set<string>();
  const aliases = new Map<string, string>();
  const head = async (key: string): Promise<ObjectInfo | null> => {
    if (removed.has(key)) return null;
    const own = await overlay.head(key);
    if (own !== null) return own;
    const info = await base.head(aliases.get(key) ?? key);
    return info === null ? null : { ...info, key };
  };
  const read = async (key: string) => (removed.has(key) ? null : ((await overlay.read(key)) ?? (await base.read(aliases.get(key) ?? key))));
  const forget = (key: string): void => {
    removed.delete(key);
    aliases.delete(key);
  };
  return {
    id: `rehearsal:${base.id}`,
    async list(prefix) {
      const merged = new Map((await base.list(prefix)).map((info) => [info.key, info]));
      for (const key of aliases.keys()) {
        const info = key.startsWith(prefix) ? await head(key) : null;
        if (info !== null) merged.set(key, info);
      }
      for (const info of await overlay.list(prefix)) merged.set(info.key, info);
      return [...merged.values()].filter((info) => !removed.has(info.key)).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },
    head,
    read,
    async get(key) {
      return (await read(key))?.data ?? null;
    },
    async put(key, data, options) {
      forget(key);
      await overlay.put(key, data, options);
    },
    async copy(sourceKey, key) {
      if ((await head(sourceKey)) === null) throw new OpsError(`${sourceKey} does not exist`, 1, sourceKey);
      const own = removed.has(sourceKey) ? null : await overlay.read(sourceKey);
      forget(key);
      if (own !== null) await overlay.put(key, own.data, own.contentType === undefined ? {} : { contentType: own.contentType });
      else {
        await overlay.delete(key);
        aliases.set(key, aliases.get(sourceKey) ?? sourceKey);
      }
    },
    async delete(key) {
      removed.add(key);
      aliases.delete(key);
      await overlay.delete(key);
    },
    locate: (key) => base.locate(key),
  };
}

function overlayOps(store: ObjectStore): BlobOps {
  return {
    copy: async (from, to) => {
      try {
        if ((await store.head(from)) === null) return err(failure("NOT_FOUND", `${from} does not exist`));
        await store.copy(from, to);
        return ok(undefined);
      } catch (cause) {
        return err(failure("TRANSIENT", `copy ${from} failed`, { cause }));
      }
    },
    head: async (key) => {
      try {
        const info = await store.head(key);
        return ok(info === null ? null : { size: info.size, sha256: null });
      } catch (cause) {
        return err(failure("TRANSIENT", `head ${key} failed`, { cause }));
      }
    },
  };
}

async function rehearseStorage(ctx: UpdateContext, plan: UpdatePlan, database: string, store: ObjectStore): Promise<RehearsalCheck> {
  if (plan.storage.length === 0) return { name: "storage-migrations", ok: true, detail: "none pending" };
  const storages = await releaseStorages(ctx);
  const blobs = blobstoreOf(store);
  const blobOps = overlayOps(store);
  const db = await openDatabase(ctx, database);
  try {
    const applied = await runShapeMigrations({ storages, db, blobs, blobOps, apply: true, blobWrites: true, answers: ctx.answers.answers, now: ctx.clock });
    if (isErr(applied)) return { name: "storage-migrations", ok: false, detail: applied.error.message };
    const left = await runShapeMigrations({ storages, db, blobs, blobOps, apply: false, blobWrites: false, answers: ctx.answers.answers, now: ctx.clock });
    if (isErr(left)) return { name: "storage-migrations", ok: false, detail: left.error.message };
    const pending = pendingStorage(left.value.modules);
    const notes = applied.value.modules.flatMap((m) => m.migrations.flatMap((r) => r.outcome?.notes ?? []));
    const counts = Object.fromEntries(applied.value.modules.flatMap((m) => m.migrations.map((r) => [r.id, r.detected.pending])));
    if (pending.length > 0) return { name: "storage-migrations", ok: false, detail: `still pending after the rehearsal: ${pending.map((m) => m.id).join(", ")}`, counts };
    return { name: "storage-migrations", ok: true, detail: `${applied.value.modules.reduce((n, m) => n + m.migrations.filter((r) => r.state === "applied").length, 0)} applied, ${notes.length} note(s)`, counts };
  } finally {
    db.close();
  }
}

async function missingOriginals(ctx: UpdateContext, database: string, store: ObjectStore): Promise<{ referenced: number; missing: string[] }> {
  const referenced = referencedBlobs(database, ctx.env.app.media);
  const live = await listMap(store, ctx.env.app.mediaPrefix);
  const missing: string[] = [];
  for (const ref of referenced) if (!live.has(ref.key) && (await store.head(ref.key)) === null) missing.push(ref.key);
  return { referenced: referenced.length, missing };
}

async function rehearseOriginals(ctx: UpdateContext, database: string, store: ObjectStore, before: number, fullMedia: boolean): Promise<RehearsalCheck> {
  const referenced = referencedBlobs(database, ctx.env.app.media);
  const { missing } = await missingOriginals(ctx, database, store);
  const present = referenced.filter((ref) => !missing.includes(ref.key));
  const sample = fullMedia ? present : present.filter((_, i) => i % Math.max(1, Math.ceil(present.length / REHEARSAL_SAMPLE)) === 0);
  const unreadable: string[] = [];
  for (const ref of sample) {
    const data = await store.get(ref.key);
    if (data === null || (ref.sha256 !== null && sha256(data) !== ref.sha256)) unreadable.push(ref.key);
  }
  const lost = missing.length > before;
  const problems = [...(lost ? [`${missing.length - before} referenced original(s) missing after the migrations, such as ${missing.slice(0, 10).join(", ")}`] : []), ...(unreadable.length > 0 ? [`${unreadable.length} original(s) unreadable or with another checksum than their row, such as ${unreadable.slice(0, 10).join(", ")}`] : [])];
  const detail = problems.length > 0 ? problems.join("; ") : `${present.length} of ${referenced.length} referenced original(s) present, ${sample.length} read back${before > 0 ? `; ${before} row(s) referenced no original already before the update` : ""}`;
  return { name: "originals", ok: problems.length === 0, detail, counts: { referenced: referenced.length, withoutBlob: missing.length, withoutBlobBefore: before, read: sample.length, unreadable: unreadable.length } };
}

async function rehearse(ctx: UpdateContext, plan: UpdatePlan, copy: string, options: PrepareOptions): Promise<Rehearsal> {
  const database = ctx.workspace.path("rehearsal.db");
  copyFileSync(copy, database);
  const timings: Record<string, number> = {};
  const checks: RehearsalCheck[] = [];
  const store = overlayStore(ctx.app);
  const before = (await missingOriginals(ctx, database, ctx.app)).missing.length;
  const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const started = ctx.clock();
    try {
      return await run();
    } finally {
      timings[name] = ctx.clock() - started;
    }
  };
  checks.push(await timed("migrate", () => rehearseStorage(ctx, plan, database, store)).catch((cause: unknown): RehearsalCheck => ({ name: "storage-migrations", ok: false, detail: messageOf(cause) })));
  if (plan.content.length > 0) {
    const blobsDir = ctx.workspace.path("rehearsal-blobs");
    mkdirSync(blobsDir, { recursive: true });
    checks.push(
      await timed("content", async (): Promise<RehearsalCheck> => {
        const result = await runContentMigrations(ctx, { database, blobsDir, expected: plan.content });
        if (result.bootMs !== null) timings.boot = result.bootMs;
        const missing = plan.content.filter((id) => !result.applied.includes(id));
        return { name: "content-migrations", ok: missing.length === 0, detail: missing.length === 0 ? `${result.applied.length} applied` : `not applied: ${missing.join(", ")}` };
      }).catch((cause: unknown): RehearsalCheck => ({ name: "content-migrations", ok: false, detail: messageOf(cause) })),
    );
  }
  const integrity = integrityCheck(database);
  checks.push({ name: "integrity", ok: integrity === "ok", detail: integrity });
  checks.push(await timed("originals", () => rehearseOriginals(ctx, database, store, before, options.fullMedia)));
  return { ok: checks.every((c) => c.ok), checks, timings, peakRssBytes: null, fullMedia: options.fullMedia };
}

async function preflightProblems(ctx: UpdateContext): Promise<{ problems: string[]; data: Record<string, unknown> }> {
  const pre = await ctx.target.preflight();
  const problems: string[] = [];
  if (pre.instances > 1 || pre.running > 1) problems.push(`the app is scaled to ${Math.max(pre.instances, pre.running)} instances; an update needs exactly one`);
  if (pre.activeDeployment !== null) problems.push(`a deployment of the platform is in progress (${pre.activeDeployment})`);
  if (pre.healthCheck !== "http") ctx.out.warn(`the app's health check is ${pre.healthCheck}; an http check on the readiness path lets the platform see a release that does not become ready`);
  const clock = await serverClock(ctx.backups, ctx.location, ctx.runId, ctx.clock, ctx.poll);
  if (Math.abs(clock.skewMs) > MAX_SKEW_MS) problems.push(`this machine's clock is ${Math.round(clock.skewMs / 1000)} s off the store's (limit ${MAX_SKEW_MS / 1000} s)`);
  return { problems, data: { instances: pre.instances, running: pre.running, activeDeployment: pre.activeDeployment, healthCheck: pre.healthCheck, readinessChecked: pre.readinessChecked !== false, skewMs: clock.skewMs } };
}

async function failed(ctx: UpdateContext, step: string, message: string, exitCode: 1 | 2 = 1): Promise<never> {
  await record(ctx, step, "failed", { error: message }).catch(() => undefined);
  throw new OpsError(message, exitCode, step);
}

/**
 * Prepares an update from this machine without changing production: preflight (one instance, no active deployment,
 * a readiness check the target can make, with exit 2 otherwise, a release configuration whose every placeholder has a
 * source, with exit 2 otherwise (`UpdateTarget.checkReleaseConfiguration` without resolving the sources, which may
 * exist only in the deploy job), the health check's type, and the clock skew against the store, measured with a probe written into the backup
 * location), plan on a copy of the newest replica generation, rehearsal of the migrations on that copy (with a local
 * start of the release when content migrations are pending), and the receipt with the version change
 * and the plan hash, written once into the backup location. Journal steps: `preflight`, `plan`, `rehearsal`,
 * `receipt`. A failed rehearsal check writes no receipt and ends with exit 1.
 */
export async function prepare(ctx: UpdateContext, options: PrepareOptions): Promise<PrepareResult> {
  let step = "preflight";
  try {
    await record(ctx, "preflight", "started");
    const pre = await preflightProblems(ctx);
    if (pre.data.readinessChecked === false) return await failed(ctx, "preflight", `preflight: ${UNCHECKED_READINESS}`, 2);
    if (pre.problems.length > 0) return await failed(ctx, "preflight", `preflight: ${pre.problems.join("; ")}`);
    try {
      await ctx.target.checkReleaseConfiguration?.({ dir: ctx.release.dir }, { resolveSources: false });
    } catch (error) {
      return await failed(ctx, "preflight", `preflight: the configuration of the release: ${messageOf(error)}`, error instanceof OpsError ? error.exitCode : 1);
    }
    await record(ctx, "preflight", "done", pre.data);

    step = "plan";
    await record(ctx, "plan", "started");
    const copy = await replicaCopy(ctx, ctx.workspace.path("plan.db"));
    const plan = await computePlan(ctx, ctx.workspace.path("plan.db"));
    const hash = planHash(plan);
    await record(ctx, "plan", "done", { planHash: hash, storage: plan.storage.map((m) => m.id), content: plan.content, questions: plan.questions });
    ctx.out.info(`plan ${hash.slice(0, 12)}: ${plan.storage.length} storage migration(s), ${plan.content.length} content migration(s)`);

    step = "rehearsal";
    await record(ctx, "rehearsal", "started", { fullMedia: options.fullMedia });
    const rehearsal = await rehearse(ctx, plan, copy, options);
    if (!rehearsal.ok) {
      await record(ctx, "rehearsal", "failed", { checks: rehearsal.checks, timings: rehearsal.timings });
      const message = `the rehearsal failed, no receipt was written: ${rehearsal.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join("; ")}`;
      throw new OpsError(message, 1, "rehearsal");
    }
    await record(ctx, "rehearsal", "done", { checks: rehearsal.checks, timings: rehearsal.timings });

    step = "receipt";
    const receipt: UpdateReceipt = { schema: "kestrel-ops/update-receipt@1", env: ctx.envName, runId: ctx.run.id, createdAt: ctx.clock(), tool: ctx.tool, versions: plan.versions, planHash: hash, plan, rehearsal };
    const key = updateKeys.receipt(ctx.envName, hash, ctx.run.id);
    if ((await ctx.backups.head(ctx.location + key)) !== null) return await failed(ctx, "receipt", `refusing to overwrite ${key}`);
    await ctx.backups.put(ctx.location + key, new TextEncoder().encode(ctx.redactor.document(receipt, 2) + "\n"), { contentType: "application/json" });
    await record(ctx, "receipt", "done", { planHash: hash, key });
    const outcome = await outcomeOf(ctx, UPDATE_EXIT.done, `receipt written (versions and plan ${hash.slice(0, 12)}). Next: commit the update and run the deploy pipeline`);
    return { receipt, outcome };
  } catch (error) {
    if (error instanceof OpsError && error.element === step) throw error;
    return failed(ctx, step, `${step}: ${messageOf(error)}`, error instanceof OpsError ? error.exitCode : 1);
  }
}
