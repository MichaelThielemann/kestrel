import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { first, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { applyPendingRestore, createBackupBlobstore, type Backup } from "./impl.ts";

export const configSchema = z
  .object({
    file: z.string().min(1),
    source: z.string().min(1).optional(),
    key: z.string().min(1),
    restoreOnStart: z.boolean().default(true),
    versions: z.number().int().min(0).default(24),
  })
  .strict();

export default defineModule({
  name: "backup/blobstore",
  provides: [],
  requires: [BLOBSTORE],
  configSchema,

  async setup(cfg, deps): Promise<Backup> {
    const applied = await applyPendingRestore(cfg.file);
    if (applied) deps.logger.info("backup/blobstore: applied pending restore", { file: cfg.file, key: applied.key, size: applied.size });
    const backup = createBackupBlobstore(cfg, deps.get(BLOBSTORE));
    if (cfg.restoreOnStart) await backup.restoreWhenMissing();
    return backup;
  },

  steps: (backup) => ({
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
    run: { summary: "Back up the file", reads: [], writes: ["result"], output: { type: "object", properties: { key: { type: "string" }, size: { type: "number" }, versions: { type: "array", items: { type: "string" } } } } },
    restore: {
      summary: "Stage the latest or a chosen version next to the file; applied on the next start",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { key: { type: "string" } }, additionalProperties: false },
      output: { type: "object", properties: { key: { type: "string" }, size: { type: "number" }, file: { type: "string" }, pending: { type: "boolean", enum: [true] }, appliedOnRestart: { type: "boolean", enum: [true] } }, required: ["key", "size", "file", "pending", "appliedOnRestart"] },
      errors: { 400: "unknown version", 404: "no backup" },
    },
    listVersions: { summary: "List backup versions", reads: [], writes: ["result"], output: { type: "object", properties: { versions: { type: "array", items: { type: "string" } } } } },
  }),
});
