import { existsSync } from "node:fs";
import { z } from "zod";
import { BLOBSTORE, type Blobstore } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { logWarn, type Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, listSealedReplica, markerKey, readOriginNonce, restoreFromBlobs, unplacedNewerGenerations, type Applied, type Config, type Replication } from "./impl.ts";
import { checkSkippedRestore, markRestoredThisBoot, reportedRestoreAt } from "./restoreFreshness.ts";

export const configSchema = z
  .object({
    file: z.string().min(1),
    prefix: z.string().default("replica/"),
    checkpointBytes: z.number().int().positive().default(4 * 1024 * 1024),
    checkpointSeconds: z.number().int().positive().default(300),
    snapshotSeconds: z.number().int().positive().default(24 * 3600),
    retentionSeconds: z.number().int().positive().default(48 * 3600),
    restoreOnStart: z.boolean().default(true),
  })
  .strict();

const POINT = { type: "object", properties: { generation: { type: "string" }, at: { type: "number" }, kind: { type: "string", enum: ["snapshot", "wal"] }, key: { type: "string" } }, required: ["generation", "at", "kind", "key"] };

type ReplicationInstance = Replication & { logger: Logger; reportedRestoreAt: () => number | null };

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

async function restoreMissingFile(config: Config, blobs: Blobstore, logger: Logger, bootStartedAt: number): Promise<void> {
  const listed = await listSealedReplica(blobs, config.prefix);
  if (isErr(listed)) throw new Error(listed.error.message, { cause: listed.error });
  const { listing, generation: newest, segments, missing } = listed.value;
  const unplaced = unplacedNewerGenerations(listing);
  if (unplaced.newest !== null && unplaced.generations.length > 0) throw new Error(unplacedGenerationsError(config.file, config.prefix, unplaced.newest, unplaced.generations));
  if (newest !== null && segments !== null && missing > 0) throw new Error(unlistedSegmentsError(config.file, config.prefix, newest, segments, missing));
  const restored = await restoreFromBlobs(blobs, config.prefix, {}, config.file, listing.points);
  if (isErr(restored)) {
    if (restored.error.message.includes("no snapshot")) return;
    throw new Error(restored.error.message, { cause: restored.error });
  }
  const { generation } = restored.value;
  const markers = listing.markers.get(generation);
  if (markers === undefined || !markers.has("origin")) {
    markRestoredThisBoot(config.file, bootStartedAt);
    return;
  }
  if (markers.has("applied")) {
    markRestoredThisBoot(config.file, bootStartedAt);
    logger.info("replication/sqlite: restored from a generation placed with origin.json that an earlier start already reported", { file: config.file, generation });
    return;
  }
  markRestoredThisBoot(config.file, bootStartedAt, true);
  const nonce = await readOriginNonce(blobs, config.prefix, generation);
  if (isErr(nonce)) {
    logWarn(logger, "replication/sqlite: restored from a generation placed with origin.json but could not read that file, so no applied.json acknowledges the restore", { file: config.file, generation, error: nonce.error.message });
    return;
  }
  const applied: Applied = { generation, nonce: nonce.value, restoredAt: bootStartedAt };
  const written = await blobs.put(markerKey(config.prefix, generation, "applied"), new TextEncoder().encode(JSON.stringify(applied)), { contentType: "application/json" });
  if (isErr(written)) logWarn(logger, "replication/sqlite: could not write applied.json; the next start that restores this generation reports the restore again", { file: config.file, generation, error: written.error.message });
  else logger.info("replication/sqlite: restored from a generation placed with origin.json and reported the restore", { file: config.file, generation, nonce: nonce.value });
}

export default defineModule({
  name: "replication/sqlite",
  provides: [],
  requires: [BLOBSTORE],
  before: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<ReplicationInstance> {
    const blobs = deps.get(BLOBSTORE);
    const bootStartedAt = deps.bootStartedAt ?? Date.now();
    const restoredFromMarker = applyPendingRestore(config.file, () => markRestoredThisBoot(config.file, bootStartedAt, true));
    if (config.restoreOnStart) {
      if (!existsSync(config.file)) await restoreMissingFile(config, blobs, deps.logger, bootStartedAt);
      else if (!restoredFromMarker) await checkSkippedRestore(config, blobs, deps.logger, bootStartedAt);
    }
    return { ...createReplicationSqlite(config, blobs, Date.now, { logger: deps.logger }), logger: deps.logger, reportedRestoreAt: () => reportedRestoreAt(config.file) };
  },

  health: (r) => r.health(),

  async teardown(r) {
    try {
      const result = await r.seal();
      if (isErr(result)) r.logger.error(TEARDOWN_FAILED, { error: result.error.message });
    } catch (err) {
      r.logger.error(TEARDOWN_FAILED, { error: err instanceof Error ? err.message : String(err) });
    }
    r.close();
  },

  steps: (replication) => ({
    checkRestored: async (ctx: Context) => {
      const previous = isRecord(ctx.result) ? ctx.result : {};
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
      summary: "When the latest restore of the file was a prepared restore or a restore of a missing file from a periodic backup, by this module or another one (adds `_databaseRestoredAt`, the start of the boot that wrote it or null, to the result)",
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
