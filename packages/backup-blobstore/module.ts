import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type Deps } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createBackupBlobstore, exists, type Backup, type Config } from "./impl.ts";
import { lockDatabaseFile, withLockHealth, type ProcessLock } from "./processLock.ts";
import { checkSkippedRestore, markRestoredThisBoot, reportedRestoreAt } from "./restoreFreshness.ts";

export const configSchema = z
  .object({
    file: z.string().min(1),
    source: z.string().min(1).optional(),
    key: z.string().min(1),
    restoreOnStart: z.boolean().default(true),
    versions: z.number().int().min(0).default(24),
    allowConcurrentProcesses: z.boolean().default(false).describe("Let other processes open the file while this one runs, instead of refusing to start beside them"),
  })
  .strict();

type BackupInstance = Backup & { lock: ProcessLock; reportedRestoreAt: () => number | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function start(cfg: Config, deps: Deps): Promise<Backup & { reportedRestoreAt: () => number | null }> {
  const blobs = deps.get(BLOBSTORE);
  const bootStartedAt = deps.bootStartedAt ?? Date.now();
  const record = (): void => markRestoredThisBoot(cfg.file, bootStartedAt, true);
  const applied = await applyPendingRestore(cfg.file, record);
  if (applied) deps.logger.info("backup/blobstore: applied pending restore", { file: cfg.file, key: applied.key, size: applied.size });
  const backup = createBackupBlobstore(cfg, blobs);
  if (cfg.restoreOnStart && !applied) {
    if (await exists(cfg.file)) await checkSkippedRestore(cfg, blobs, deps.logger, bootStartedAt);
    else await backup.restoreWhenMissing(record);
  }
  return { ...backup, reportedRestoreAt: () => reportedRestoreAt(cfg.file) };
}

export default defineModule({
  name: "backup/blobstore",
  provides: [],
  requires: [BLOBSTORE],
  before: [PERSISTENCE],
  configSchema,

  async setup(cfg, deps): Promise<BackupInstance> {
    const lock = lockDatabaseFile(cfg.file, "backup/blobstore", cfg.allowConcurrentProcesses);
    try {
      return { ...(await start(cfg, deps)), lock };
    } catch (err) {
      lock.release();
      throw err;
    }
  },

  teardown: (backup) => backup.lock.release(),

  health: (backup) => withLockHealth(backup.lock, { ok: true }),

  steps: (backup) => ({
    checkRestored: async (ctx: Context) => {
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, _databaseRestoredAt: backup.reportedRestoreAt() } });
    },
    run: async (ctx: Context) => {
      const result = await backup.backup();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: result.value });
    },
    restore: async (ctx: Context) => {
      const key = first(ctx.payload.key);
      if (key !== undefined) {
        const versions = await backup.versions();
        if (isErr(versions)) return ctx.fail(versions.error);
        if (!versions.value.includes(key) && key !== backup.key) return ctx.fail("VALIDATION", `unknown backup version ${key}`);
      }
      const result = await backup.prepareRestore(key);
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { key: result.value.key, size: result.value.size, file: result.value.file, pending: true, appliedOnRestart: true } });
    },
    listVersions: async (ctx: Context) => {
      const result = await backup.versions();
      if (isErr(result)) return ctx.fail(result.error);
      return ok({ ...ctx, result: { versions: result.value } });
    },
  }),

  describe: () => ({
    checkRestored: {
      summary: "When the latest restore of the file was a prepared restore or a restore of a missing file from a periodic backup, by this module or another one (adds `_databaseRestoredAt`, the start of the boot that wrote it or null, to the result)",
      reads: [],
      writes: ["result._databaseRestoredAt"],
      extendsOutput: { type: "object", properties: { _databaseRestoredAt: { type: ["number", "null"] } }, required: ["_databaseRestoredAt"] },
    },
    run: { summary: "Back up the file", reads: [], writes: ["result"], output: { type: "object", properties: { key: { type: "string" }, size: { type: "number" }, versions: { type: "array", items: { type: "string" } } }, required: ["key", "size", "versions"] } },
    restore: {
      summary: "Stage the latest or a chosen version next to the file; applied on the next start on the same disk, lost on an ephemeral disk",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { key: { type: "string" } }, additionalProperties: false },
      output: { type: "object", properties: { key: { type: "string" }, size: { type: "number" }, file: { type: "string" }, pending: { type: "boolean", enum: [true] }, appliedOnRestart: { type: "boolean", enum: [true] } }, required: ["key", "size", "file", "pending", "appliedOnRestart"] },
      errors: { 400: "unknown version", 404: "no backup" },
    },
    listVersions: { summary: "List backup versions", reads: [], writes: ["result"], output: { type: "object", properties: { versions: { type: "array", items: { type: "string" } } }, required: ["versions"] } },
  }),
});
