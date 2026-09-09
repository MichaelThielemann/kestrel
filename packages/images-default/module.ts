import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { binaryResult, first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { DEFAULT_MAX_ATTEMPTS, createImages, type Images, type Variant } from "./impl.ts";
import { sizeSchema } from "./sizes.ts";

export const configSchema = z
  .object({
    sizes: z.array(sizeSchema).optional(),
    prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)+$/, 'prefix must be one or more "<segment>/" parts, e.g. "media-variants/"').default("media-variants/"),
    publicPath: z.string().regex(/^\/[A-Za-z0-9._/-]*$/).default("/media"),
    media: z.object({ collection: z.string().min(1) }).default({ collection: "media_items" }),
    chunk: z.number().int().min(1).max(500).default(20),
    staleAfterMs: z.number().int().positive().default(60000),
    maxAttempts: z.number().int().positive().default(DEFAULT_MAX_ATTEMPTS),
  })
  .strict();

function mediaId(ctx: Context): string | undefined {
  if (ctx.params.id) return ctx.params.id;
  return first(ctx.payload.id);
}

function attachedVariant(images: Images, variant: Variant): { size: string; width: number; height: number; format: string; bytes: number; state: Variant["state"]; path: string } {
  return { size: variant.size, width: variant.width, height: variant.height, format: variant.format, bytes: variant.bytes, state: variant.state, path: images.publicPath(variant.mediaId, variant) };
}

const SIZE_SCHEMA = { type: "object", properties: { name: { type: "string" }, width: { type: "number" }, height: { type: ["number", "null"] }, fit: { type: "string", enum: ["inside", "cover"] }, format: { type: "string", enum: ["webp", "original"] }, quality: { type: "number" }, source: { type: "string", enum: ["default", "config", "registered"] }, updatedAt: { type: "number" } }, required: ["name", "width", "fit", "format", "quality", "source", "updatedAt"] };
const SIZE_INPUT_SCHEMA = { type: "object", properties: { name: { type: "string" }, width: { type: "integer", minimum: 16, maximum: 8192 }, height: { type: "integer", minimum: 16, maximum: 8192 }, fit: { type: "string", enum: ["inside", "cover"] }, format: { type: "string", enum: ["webp", "original"] }, quality: { type: "integer", minimum: 1, maximum: 100 } }, required: ["name", "width"], additionalProperties: false };
const GENERATE_INPUT_SCHEMA = { type: "object", properties: { id: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, additionalProperties: true, description: "reached either directly (id/ids) or as the media.uploaded event envelope, which carries further fields this step ignores" };
const VARIANT_SCHEMA = { type: "object", properties: { id: { type: "string" }, mediaId: { type: "string" }, size: { type: "string" }, spec: { type: "string" }, width: { type: "number" }, height: { type: "number" }, format: { type: "string" }, key: { type: "string" }, bytes: { type: "number" }, state: { type: "string", enum: ["pending", "done", "error", "failed"] }, error: { type: ["string", "null"] }, attempts: { type: "number" }, updatedAt: { type: "number" } }, required: ["id", "mediaId", "size", "spec", "width", "height", "format", "key", "bytes", "state", "error", "attempts", "updatedAt"] };
const JOB_SCHEMA = { type: "object", properties: { id: { type: "string" }, state: { type: "string", enum: ["running", "paused", "done", "error"] }, total: { type: "number" }, done: { type: "number" }, failed: { type: "number" }, cursor: { type: "string" }, startedAt: { type: "number" }, updatedAt: { type: "number" }, finishedAt: { type: ["number", "null"] }, error: { type: ["string", "null"] } }, required: ["id", "state", "total", "done", "failed", "cursor", "startedAt", "updatedAt", "finishedAt", "error"] };
const ATTACHED_VARIANT_SCHEMA = { type: "object", properties: { size: { type: "string" }, width: { type: "number" }, height: { type: "number" }, format: { type: "string" }, bytes: { type: "number" }, state: { type: "string", enum: ["pending", "done", "error", "failed"] }, path: { type: "string" } }, required: ["size", "width", "height", "format", "bytes", "state", "path"] };

export default defineModule({
  name: "images/default",
  provides: [],
  requires: [BLOBSTORE, PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<Images> {
    return createImages(config, { blobs: deps.get(BLOBSTORE), db: deps.get(PERSISTENCE), logger: deps.logger });
  },

  steps: (images) => ({
    register: async (ctx: Context) => {
      const sizes = await images.register(ctx.payload.sizes);
      if (isErr(sizes)) return ctx.fail(sizes.error);
      return ok({ ...ctx, result: sizes.value });
    },

    listSizes: async (ctx: Context) => ok({ ...ctx, result: await images.sizes() }),

    generate: async (ctx: Context) => {
      const idsPayload = ctx.payload.ids;
      if (Array.isArray(idsPayload)) {
        const items: Array<{ id: string; variants: Variant[] }> = [];
        for (const id of idsPayload.filter((value): value is string => typeof value === "string")) {
          const known = await images.exists(id);
          if (isErr(known)) return ctx.fail(known.error);
          if (!known.value) continue;
          const variants = await images.generate(id);
          if (isErr(variants)) return ctx.fail(variants.error);
          items.push({ id, variants: variants.value });
        }
        return ok({ ...ctx, result: { items } });
      }
      const id = mediaId(ctx);
      if (!id) return ctx.fail("VALIDATION", "images: missing media id");
      const known = await images.exists(id);
      if (isErr(known)) return ctx.fail(known.error);
      if (!known.value) return ctx.fail("NOT_FOUND", `images: media/${id} not found`);
      const variants = await images.generate(id);
      if (isErr(variants)) return ctx.fail(variants.error);
      return ok({ ...ctx, result: { id, variants: variants.value } });
    },

    sync: async (ctx: Context) => {
      const job = await images.sync();
      if (isErr(job)) return ctx.fail(job.error);
      return ok({ ...ctx, result: job.value });
    },

    resume: async (ctx: Context) => {
      const job = await images.resume();
      if (isErr(job)) return ctx.fail(job.error);
      return ok({ ...ctx, result: job.value });
    },

    prune: async (ctx: Context) => {
      const names = ctx.payload.sizes;
      if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) return ctx.fail("VALIDATION", "images: missing sizes");
      const pruned = await images.prune(names as string[]);
      if (isErr(pruned)) return ctx.fail(pruned.error);
      return ok({ ...ctx, result: pruned.value });
    },

    readStatus: async (ctx: Context) => {
      const status = await images.status();
      if (isErr(status)) return ctx.fail(status.error);
      return ok({ ...ctx, result: status.value });
    },

    remove: async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "images: missing id");
      const removed = await images.remove(ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    },

    removeMany: async (ctx: Context) => {
      const ids = (ctx.result as { ids?: unknown } | undefined)?.ids;
      if (!Array.isArray(ids)) throw new Error("images: removeMany: no ids in result");
      for (const id of ids as string[]) {
        const removed = await images.remove(id);
        if (isErr(removed)) return ctx.fail(removed.error);
      }
      return ok(ctx);
    },

    attach: async (ctx: Context) => {
      const result = ctx.result as { id?: unknown; items?: unknown } | undefined;
      if (typeof result?.id === "string") {
        const byMedia = await images.variantsOf([result.id]);
        if (isErr(byMedia)) return ctx.fail(byMedia.error);
        const variants = byMedia.value.get(result.id) ?? [];
        return ok({ ...ctx, result: { ...result, variants: variants.map((v) => attachedVariant(images, v)) } });
      }
      if (Array.isArray(result?.items)) {
        const items = result.items as Array<Record<string, unknown>>;
        const ids = items.map((item) => item.id).filter((id): id is string => typeof id === "string");
        const byMedia = await images.variantsOf(ids);
        if (isErr(byMedia)) return ctx.fail(byMedia.error);
        const withVariants = items.map((item) => {
          const variants = typeof item.id === "string" ? (byMedia.value.get(item.id) ?? []) : [];
          return { ...item, variants: variants.map((v) => attachedVariant(images, v)) };
        });
        return ok({ ...ctx, result: { ...result, items: withVariants } });
      }
      throw new Error("images: attach: no media item(s) in result");
    },

    serve: async (ctx: Context) => {
      const id = ctx.params.id;
      const file = ctx.params.file;
      if (!id || !file) return ctx.fail("VALIDATION", "images: missing id or file");
      const found = await images.read(id, file);
      if (isErr(found)) return ctx.fail(found.error);
      if (found.value === null) {
        const failed = await images.failure(id, file);
        if (isErr(failed)) return ctx.fail(failed.error);
        if (failed.value) return ctx.fail("NOT_FOUND", `images: variant ${failed.value.size} for media/${id} failed after ${failed.value.attempts} attempts: ${failed.value.error ?? "unknown error"}`);
        return ctx.fail("NOT_FOUND", `images: media/${id}/variants/${file} not found`);
      }
      const result = binaryResult(found.value.data, found.value.contentType, file);
      if (found.value.fallback) result.headers = { "x-kestrel-variant": found.value.variant };
      return ok({ ...ctx, result });
    },

    export: stepFactory((dir: string) => async (ctx: Context) => {
      const variants = await images.exportTo(dir);
      if (isErr(variants)) return ctx.fail(variants.error);
      // the step runs after media.export in the same pipeline; replacing ctx.result would drop that
      // step's counts, so the variant counts are nested under their own key instead.
      const previous = typeof ctx.result === "object" && ctx.result !== null && !Array.isArray(ctx.result) ? (ctx.result as Record<string, unknown>) : {};
      return ok({ ...ctx, result: { ...previous, variants: variants.value } });
    }),
  }),

  teardown: (images) => images.close(),

  describe: () => ({
    register: { summary: "Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored", reads: [], writes: ["result"], input: { type: "object", properties: { sizes: { type: "array", items: SIZE_INPUT_SCHEMA } }, required: ["sizes"], additionalProperties: false }, output: { type: "array", items: SIZE_SCHEMA }, errors: { 400: "empty list or invalid size definition", 409: "a size collides with a config size" } },
    listSizes: { summary: "Effective sizes (defaults/config merged with the sizes registered in this process)", reads: [], writes: ["result"], output: { type: "array", items: SIZE_SCHEMA } },
    generate: { summary: "Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped)", reads: [], writes: ["result"], input: GENERATE_INPUT_SCHEMA, output: { oneOf: [{ type: "object", properties: { id: { type: "string" }, variants: { type: "array", items: VARIANT_SCHEMA } }, required: ["id", "variants"] }, { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, variants: { type: "array", items: VARIANT_SCHEMA } }, required: ["id", "variants"] } } }, required: ["items"] }] }, errors: { 400: "missing media id", 404: "media item not found" } },
    sync: { summary: "Start a sync job, or resume a paused/error/stale one", reads: [], writes: ["result"], output: JOB_SCHEMA, errors: { 409: "a fresh job is already running" } },
    resume: { summary: "Resume a paused/error/stale job, or no-op (for cron)", reads: [], writes: ["result"], output: { oneOf: [JOB_SCHEMA, { type: "null" }] } },
    prune: { summary: "Delete the variants of sizes that are no longer declared", reads: [], writes: ["result"], input: { type: "object", properties: { sizes: { type: "array", items: { type: "string" } } }, required: ["sizes"], additionalProperties: false }, output: { type: "object", properties: { sizes: { type: "number" }, variants: { type: "number" } }, required: ["sizes", "variants"] }, errors: { 400: "missing sizes, or a name is still declared or has no variants" } },
    readStatus: {
      summary: "Sizes with usage/variant counts, current job, and sizes whose variants are left over from a size the code no longer declares",
      reads: [],
      writes: ["result"],
      output: {
        type: "object",
        properties: {
          sizes: { type: "array", items: { type: "object", properties: { ...SIZE_SCHEMA.properties, used: { type: "boolean" }, variants: { type: "object", properties: { done: { type: "number" }, pending: { type: "number" }, error: { type: "number" }, failed: { type: "number" } }, required: ["done", "pending", "error", "failed"] } }, required: [...SIZE_SCHEMA.required, "used", "variants"] } },
          job: { oneOf: [JOB_SCHEMA, { type: "null" }] },
          orphaned: { type: "object", properties: { sizes: { type: "array", items: { type: "string" } }, variants: { type: "number" } }, required: ["sizes", "variants"] },
          registrySeen: { type: "boolean" },
        },
        required: ["sizes", "job", "orphaned", "registrySeen"],
      },
    },
    remove: { summary: "Delete one media item's variants (blob + rows)", reads: ["params.id"], writes: [], errors: { 400: "missing id" } },
    removeMany: { summary: "Delete variants for every id in result.ids (from media.folderItems)", reads: ["result.ids"], writes: [] },
    attach: { summary: "Add variants[] to a media item or list (result.id or result.items)", reads: ["result"], writes: ["result.variants"], extendsItems: { type: "object", properties: { variants: { type: "array", items: ATTACHED_VARIANT_SCHEMA } }, required: ["variants"] } },
    serve: { summary: "Binary variant, or the original with x-kestrel-variant: pending while it isn't ready yet", reads: ["params.id", "params.file"], writes: ["result"], binary: true, errors: { 400: "missing id or file", 404: "media item or size not found, or the variant gave up after maxAttempts" } },
    export: (dir: string) => ({ summary: `Copy every done variant to ${dir}/<folder>/<filename>.<size>.<ext>`, reads: [], writes: ["result.variants"], extendsOutput: { type: "object", properties: { variants: { type: "object", properties: { written: { type: "number" }, skipped: { type: "number" } }, required: ["written", "skipped"] } }, required: ["variants"] } }),
  }),
});
