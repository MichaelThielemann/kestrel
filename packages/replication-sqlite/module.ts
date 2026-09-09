import { existsSync } from "node:fs";
import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { first, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import type { Logger } from "@michaelthielemann/kestrel/logger";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createReplicationSqlite, restoreFromBlobs, type Replication } from "./impl.ts";

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

type ReplicationInstance = Replication & { logger: Logger };

export default defineModule({
  name: "replication/sqlite",
  provides: [],
  requires: [BLOBSTORE],
  configSchema,

  async setup(config, deps): Promise<ReplicationInstance> {
    const blobs = deps.get(BLOBSTORE);
    applyPendingRestore(config.file);
    if (config.restoreOnStart && !existsSync(config.file)) {
      const restored = await restoreFromBlobs(blobs, config.prefix, {}, config.file);
      if (isErr(restored) && !restored.error.message.includes("no snapshot")) throw new Error(restored.error.message, { cause: restored.error });
    }
    return { ...createReplicationSqlite(config, blobs), logger: deps.logger };
  },

  async teardown(r) {
    try {
      const result = await r.sync();
      if (isErr(result)) r.logger.error("replication/sqlite: failed to ship pending WAL frames on teardown", { error: result.error.message });
    } catch (err) {
      r.logger.error("replication/sqlite: failed to ship pending WAL frames on teardown", { error: err instanceof Error ? err.message : String(err) });
    }
    r.close();
  },

  steps: (replication) => ({
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
    sync: { summary: "Ship new WAL frames, checkpoint, snapshot and prune when due", reads: [], writes: ["result"], output: { type: "object", properties: { generation: { type: "string" }, shippedBytes: { type: "number" }, frames: { type: "number" }, checkpointed: { type: "boolean" }, pruned: { type: "number" } } } },
    snapshot: { summary: "Start a new generation with a full snapshot", reads: [], writes: ["result"], output: { type: "object", properties: { generation: { type: "string" }, bytes: { type: "number" } } } },
    listPoints: { summary: "Restore points (snapshots and WAL segments)", reads: [], writes: ["result"], output: { type: "array", items: POINT } },
    readStatus: { summary: "Replication status", reads: [], writes: ["result"], output: { type: "object", properties: { generation: { type: ["string", "null"] }, lineage: { type: "number" }, shippedFrames: { type: "number" }, lastSyncAt: { type: ["number", "null"] }, lastSnapshotAt: { type: ["number", "null"] }, lastCheckpointAt: { type: ["number", "null"] }, walBytes: { type: "number" }, pendingRestore: { type: ["string", "null"] } } } },
    prepareRestore: { summary: "Rebuild the database at a point in time next to the live file; applied on next start", reads: [], writes: ["result"], input: { type: "object", properties: { generation: { type: "string" }, at: { type: ["number", "string"], description: "milliseconds or ISO-8601; default latest" } }, additionalProperties: false }, output: { type: "object", properties: { generation: { type: "string" }, at: { type: "number" }, file: { type: "string" }, restartRequired: { type: "boolean", enum: [true] } }, required: ["generation", "at", "file", "restartRequired"] }, errors: { 400: 'invalid "at" value', 404: "no snapshot before the requested point" } },
  }),
});
