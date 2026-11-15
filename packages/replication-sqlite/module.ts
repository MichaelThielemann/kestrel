import { existsSync, renameSync, rmSync } from "node:fs";
import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import type { Manifest } from "@michaelthielemann/kestrel";
import { first, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type Deps } from "@michaelthielemann/kestrel/defineModule";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, listSealedReplica, markerKey, readOrigin, restoreFromBlobs, unplacedNewerGenerations, type Config, type GenerationMarker, type PlacedRestore, type Replication, type ReplicaListing, type ReplicationOptions } from "./impl.ts";
import { lockDatabaseFile, withLockHealth, type ProcessLock } from "./processLock.ts";
import { checkSkippedRestore, markRestoredThisBoot, reportedRestoreAt, unacknowledgedRestore } from "./restoreFreshness.ts";

export const configSchema = z
  .object({
    file: z.string().min(1),
    prefix: z.string().default("replica/"),
    checkpointBytes: z.number().int().positive().default(4 * 1024 * 1024),
    checkpointSeconds: z.number().int().positive().default(300),
    snapshotSeconds: z.number().int().positive().default(24 * 3600),
    retentionSeconds: z.number().int().positive().default(48 * 3600),
    restoreOnStart: z.boolean().default(true),
    allowConcurrentProcesses: z.boolean().default(false).describe("Let other processes open the file while this one runs, instead of refusing to start beside them"),
  })
  .strict();

const POINT = { type: "object", properties: { generation: { type: "string" }, at: { type: "number" }, kind: { type: "string", enum: ["snapshot", "wal"] }, key: { type: "string" } }, required: ["generation", "at", "kind", "key"] };

type ReplicationInstance = Replication & { logger: Logger; lock: ProcessLock; reportedRestoreAt: () => number | null; reportRuns: Set<string> | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TEARDOWN_FAILED = "replication/sqlite: failed to ship pending WAL frames and seal the generation on teardown; the replica lacks the frames committed since the last sync until the next start takes a new snapshot, and the generation stays unsealed";

function unplacedGenerationsError(file: string, prefix: string, newest: string, generations: readonly string[]): string {
  const one = generations.length === 1;
  const named = one ? `generation ${generations.join("")}` : `generations ${generations.join(", ")}`;
  return `replication/sqlite: refusing to restore ${file} from the replica: ${named} under ${prefix}gen/ ${one ? "is" : "are"} named by time alone without origin.json, yet sort${one ? "s" : ""} after ${newest}, the newest generation that this version wrote or that was placed with origin.json. A 5.x release, or another process writing to the same prefix, wrote ${one ? "it" : "them"}, and restoring the newest generation would start from that data. If that data is wanted, add an origin.json to ${prefix}gen/${generations.at(-1) ?? ""}/ and start again; otherwise move ${one ? "it" : "them"} out of ${prefix}gen/ to start from ${newest}.`;
}

function unlistedSegmentsError(file: string, prefix: string, generation: string, segments: number, missing: number): string {
  return `replication/sqlite: refusing to restore ${file} from generation ${generation}: its sealed.json names ${segments} WAL segments, but repeated listings of ${prefix}gen/${generation}/wal/ show only ${segments - missing}. The blobstore lists new keys late, or segments were removed. Start again once the listing shows them all; to restore from the listed segments alone, move ${prefix}gen/${generation}/sealed.json aside.`;
}

const rebuildFile = (file: string): string => `${file}.rebuilding`;

interface StartListing {
  keys: string[];
  at: number;
}

interface MissingFileRestore {
  listedBefore: StartListing;
  placed?: PlacedRestore;
}

function placedWithoutSnapshotError(file: string, prefix: string, generations: readonly string[]): string {
  const generation = generations.at(-1) ?? "";
  return `replication/sqlite: refusing to restore ${file} from the replica: repeated listings show origin.json in generation ${generation} under ${prefix}gen/, but no snapshot.db in it, and it sorts after the newest generation with a snapshot. The blobstore lists new keys late, or the placement wrote origin.json before its snapshot and did not finish. Start again once the listing shows ${prefix}gen/${generation}/snapshot.db; if the placement did not finish, move ${prefix}gen/${generation}/ out of ${prefix}gen/.`;
}

async function readsBack(blobs: Blobstore, key: string): Promise<boolean> {
  const blob = await blobs.get(key);
  if (isErr(blob)) throw new Error(blob.error.message, { cause: blob.error });
  return blob.value !== null;
}

async function confirmedUnplaced(blobs: Blobstore, prefix: string, listing: ReplicaListing): Promise<ReturnType<typeof unplacedNewerGenerations>> {
  const unplaced = unplacedNewerGenerations(listing);
  if (unplaced.generations.length === 0) return unplaced;
  for (const generation of unplaced.generations) {
    if (await readsBack(blobs, markerKey(prefix, generation, "origin"))) listing.markers.set(generation, (listing.markers.get(generation) ?? new Set<GenerationMarker>()).add("origin"));
  }
  return unplacedNewerGenerations(listing);
}

async function restoreMissingFile(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number): Promise<MissingFileRestore> {
  const at = Date.now();
  const listed = await listSealedReplica(blobs, config.prefix);
  if (isErr(listed)) throw new Error(listed.error.message, { cause: listed.error });
  const { listing, generation: newest, segments, missing, withoutSnapshot } = listed.value;
  const startListing = { listedBefore: { keys: listing.points.map((p) => p.key), at } };
  if (withoutSnapshot.length > 0) throw new Error(placedWithoutSnapshotError(config.file, config.prefix, withoutSnapshot));
  const unplaced = await confirmedUnplaced(blobs, config.prefix, listing);
  if (unplaced.newest !== null && unplaced.generations.length > 0) throw new Error(unplacedGenerationsError(config.file, config.prefix, unplaced.newest, unplaced.generations));
  if (newest !== null && segments !== null && missing > 0) throw new Error(unlistedSegmentsError(config.file, config.prefix, newest, segments, missing));
  const rebuilt = rebuildFile(config.file);
  const restored = await restoreFromBlobs(blobs, config.prefix, {}, rebuilt, listing.points);
  if (isErr(restored)) {
    if (restored.error.message.includes("no snapshot")) return startListing;
    throw new Error(restored.error.message, { cause: restored.error });
  }
  const { generation } = restored.value;
  const recorded = await recordRebuild(config, blobs, logger, bootStartedAt, generation, listing.markers.get(generation)?.has("applied") === true);
  for (const suffix of ["-wal", "-shm"]) rmSync(config.file + suffix, { force: true });
  renameSync(rebuilt, config.file);
  return recorded === undefined ? startListing : { ...startListing, placed: recorded };
}

async function recordRebuild(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number, generation: string, acknowledged: boolean): Promise<PlacedRestore | undefined> {
  const origin = await readOrigin(blobs, config.prefix, generation);
  if (isErr(origin) && origin.error.code === "NOT_FOUND") {
    markRestoredThisBoot(config.file, bootStartedAt);
    return undefined;
  }
  if (isErr(origin)) {
    markRestoredThisBoot(config.file, bootStartedAt, true);
    logWarn(logger, "replication/sqlite: restored from a generation that may carry origin.json but could not read that file, so the restore is reported and no applied.json acknowledges it", { file: config.file, generation, error: origin.error.message });
    return undefined;
  }
  if (acknowledged) {
    markRestoredThisBoot(config.file, bootStartedAt);
    logger.info("replication/sqlite: restored from a generation placed with origin.json that an earlier start already reported", { file: config.file, generation });
    return undefined;
  }
  const placed: PlacedRestore = { applied: { generation, nonce: origin.value.nonce, restoredAt: bootStartedAt }, origin: origin.value.content };
  markRestoredThisBoot(config.file, bootStartedAt, true, placed);
  logger.info("replication/sqlite: restored from a generation placed with origin.json and reported the restore", { file: config.file, generation, nonce: origin.value.nonce });
  return placed;
}

function reportingSteps(manifest: Manifest): Set<string> {
  return new Set(manifest.pipelines.flatMap((pipeline) => pipeline.steps.filter((step) => step.description.writes.includes("result._databaseRestoredAt")).map((step) => step.spec)));
}

async function start(config: Config, deps: Deps, lock: ProcessLock): Promise<ReplicationInstance> {
  const blobs = deps.get(BLOBSTORE);
  const bootStartedAt = deps.bootStartedAt ?? Date.now();
  const restoredFromMarker = applyPendingRestore(config.file, () => markRestoredThisBoot(config.file, bootStartedAt, true));
  let restore: MissingFileRestore | undefined;
  if (config.restoreOnStart) {
    if (!existsSync(config.file)) restore = await restoreMissingFile(config, blobs, deps.logger, bootStartedAt);
    else if (!restoredFromMarker) await checkSkippedRestore(config, blobs, deps.logger, bootStartedAt);
  }
  const placed = restore === undefined ? unacknowledgedRestore(config.file) : (restore.placed ?? null);
  const options: ReplicationOptions = { logger: deps.logger };
  if (restore !== undefined) options.listedBefore = restore.listedBefore;
  if (placed !== null) {
    options.placedRestore = placed;
    options.onAcknowledged = () => {
      if (unacknowledgedRestore(config.file)?.applied.generation === placed.applied.generation) markRestoredThisBoot(config.file, placed.applied.restoredAt, true);
    };
  }
  return { ...createReplicationSqlite(config, blobs, Date.now, options), logger: deps.logger, lock, reportedRestoreAt: () => reportedRestoreAt(config.file), reportRuns: placed === null ? null : new Set<string>() };
}

export default defineModule({
  name: "replication/sqlite",
  provides: [],
  requires: [BLOBSTORE],
  before: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<ReplicationInstance> {
    const lock = lockDatabaseFile(config.file, "replication/sqlite", config.allowConcurrentProcesses);
    try {
      return await start(config, deps, lock);
    } catch (err) {
      lock.release();
      throw err;
    }
  },

  attach(replication, kestrel) {
    const runs = replication.reportRuns;
    if (runs === null) return;
    const reporting = reportingSteps(kestrel.describe());
    if (reporting.size === 0) {
      replication.restoreHandled();
      return;
    }
    return kestrel.observe({
      stepStart(event) {
        if (reporting.has(event.step)) runs.add(event.runId);
      },
      runEnd(event) {
        if (runs.delete(event.runId) && event.outcome === "ok") replication.restoreHandled();
      },
    });
  },

  health: (r) => withLockHealth(r.lock, r.health()),

  quiesce: (r) => r.quiesce(),

  async teardown(r) {
    try {
      const result = await r.seal();
      if (isErr(result)) r.logger.error(TEARDOWN_FAILED, { error: result.error.message });
    } catch (err) {
      r.logger.error(TEARDOWN_FAILED, { error: err instanceof Error ? err.message : String(err) });
    }
    try {
      r.close();
    } finally {
      r.lock.release();
    }
  },

  steps: (replication) => ({
    checkRestored: async (ctx: Context) => {
      const previous = isRecord(ctx.result) ? ctx.result : {};
      replication.reportRuns?.add(ctx.runId);
      return ok({ ...ctx, result: { ...previous, _databaseRestoredAt: replication.reportedRestoreAt() } });
    },
    sync: async (ctx: Context) => {
      const result = await replication.sync();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    snapshot: async (ctx: Context) => {
      const result = await replication.snapshot();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    listPoints: async (ctx: Context) => {
      const result = await replication.points();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    readStatus: async (ctx: Context) => ok({ ...ctx, result: await replication.status() }),
    prepareRestore: async (ctx: Context) => {
      const target: { generation?: string; at?: number } = {};
      const generation = first(ctx.payload.generation);
      if (generation !== undefined) target.generation = generation;
      if (typeof ctx.payload.at === "number") target.at = ctx.payload.at;
      else {
        const at = first(ctx.payload.at);
        if (at !== undefined) {
          const parsed = Date.parse(at);
          if (!Number.isFinite(parsed)) return ctx.fail("VALIDATION", `invalid "at" value ${JSON.stringify(at)}`);
          target.at = parsed;
        }
      }
      const result = await replication.prepareRestore(target);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
  }),

  describe: () => ({
    checkRestored: {
      summary: "When the latest restore of the file was a prepared restore, a restore of a missing file from a periodic backup or a rebuild of a missing file from a generation placed with origin.json, by this module or another one (adds `_databaseRestoredAt`, the start of the boot that wrote it or null, to the result)",
      reads: [],
      writes: ["result._databaseRestoredAt"],
      extendsOutput: { type: "object", properties: { _databaseRestoredAt: { type: ["number", "null"] } }, required: ["_databaseRestoredAt"] },
    },
    sync: { summary: "Ship new WAL frames, checkpoint, snapshot and prune when due", reads: [], writes: ["result"], output: { type: "object", properties: { generation: { type: "string" }, shippedBytes: { type: "number" }, frames: { type: "number" }, checkpointed: { type: "boolean" }, pruned: { type: "number" } }, required: ["generation", "shippedBytes", "frames", "checkpointed", "pruned"] } },
    snapshot: { summary: "Start a new generation with a full snapshot", reads: [], writes: ["result"], output: { type: "object", properties: { generation: { type: "string" }, bytes: { type: "number" } }, required: ["generation", "bytes"] } },
    listPoints: { summary: "Restore points (snapshots and WAL segments)", reads: [], writes: ["result"], output: { type: "array", items: POINT } },
    readStatus: {
      summary: "Replication status",
      reads: [],
      writes: ["result"],
      output: {
        type: "object",
        properties: { generation: { type: ["string", "null"] }, lineage: { type: "number" }, shippedFrames: { type: "number" }, lastSyncAt: { type: ["number", "null"] }, lastSnapshotAt: { type: ["number", "null"] }, lastCheckpointAt: { type: ["number", "null"] }, walBytes: { type: "number" }, pendingRestore: { type: ["string", "null"] } },
        required: ["generation", "lineage", "shippedFrames", "lastSyncAt", "lastSnapshotAt", "lastCheckpointAt", "walBytes", "pendingRestore"],
      },
    },
    prepareRestore: { summary: "Rebuild the database at a point in time next to the live file; applied on next start", reads: [], writes: ["result"], input: { type: "object", properties: { generation: { type: "string" }, at: { type: ["number", "string"], description: "milliseconds or ISO-8601; default latest" } }, additionalProperties: false }, output: { type: "object", properties: { generation: { type: "string" }, at: { type: "number" }, file: { type: "string" }, restartRequired: { type: "boolean", enum: [true] } }, required: ["generation", "at", "file", "restartRequired"] }, errors: { 400: 'invalid "at" value', 404: "no snapshot before the requested point" } },
  }),
});
