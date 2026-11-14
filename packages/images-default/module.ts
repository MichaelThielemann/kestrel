import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { MEDIA } from "@michaelthielemann/kestrel-contracts/media";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { ownedPersistence } from "@michaelthielemann/kestrel-contracts/helpers/persistence.owned";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { binaryResult, first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import type { FramingView } from "./framed.ts";
import { parseCrop, type PixelCrop } from "./framing.ts";
import { eligible } from "./generate.ts";
import { COLLECTIONS, DEFAULT_MAX_ATTEMPTS, DEFAULT_RENDER_TIMEOUT_MS, createImages, type Images, type Variant, type VariantCounts } from "./impl.ts";
import { sizeSchema } from "./sizes.ts";

export const configSchema = z
  .object({
    sizes: z.array(sizeSchema).optional(),
    prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)+$/, 'prefix must be one or more "<segment>/" parts, e.g. "media-variants/"').default("media-variants/"),
    publicPath: z.string().regex(/^(\/[A-Za-z0-9._-]+)+$/, 'publicPath must be "/" followed by path segments, without a trailing "/", e.g. "/media"').default("/media"),
    publicCopy: z
      .object({
        prefix: z.string().regex(/^([A-Za-z0-9._-]+\/)*$/, 'publicCopy.prefix must be "" or one or more "<segment>/" parts, e.g. "site/"'),
      })
      .strict()
      .optional(),
    chunk: z.number().int().min(1).max(500).default(20),
    staleAfterMs: z.number().int().positive().default(60000),
    maxAttempts: z.number().int().positive().default(DEFAULT_MAX_ATTEMPTS),
    renderTimeoutMs: z.number().int().positive().default(DEFAULT_RENDER_TIMEOUT_MS),
  })
  .strict()
  .refine((config) => config.renderTimeoutMs < config.staleAfterMs, { message: "renderTimeoutMs must be less than staleAfterMs", path: ["renderTimeoutMs"] });

function mediaId(ctx: Context): string | undefined {
  if (ctx.params.id) return ctx.params.id;
  return first(ctx.payload.id);
}

function mediaIds(ctx: Context): string[] | undefined {
  const idsPayload = ctx.payload.ids;
  return Array.isArray(idsPayload) ? idsPayload.filter((v): v is string => typeof v === "string") : undefined;
}

function resultIds(ctx: Context, step: string): string[] {
  const ids = boundaryCast<{ ids?: unknown } | undefined>(ctx.result, "host")?.ids;
  if (!Array.isArray(ids)) throw new Error(`images: ${step}: no ids in result`);
  return ids.filter((id): id is string => typeof id === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultVersions(ctx: Context): Record<string, number> | undefined {
  const versions = boundaryCast<{ trashVersions?: unknown } | undefined>(ctx.result, "host")?.trashVersions;
  if (!isRecord(versions)) return undefined;
  const out: Record<string, number> = {};
  for (const [id, version] of Object.entries(versions)) if (typeof version === "number" && Number.isSafeInteger(version) && version >= 0) out[id] = version;
  return out;
}

function attachedVariant(images: Images, variant: Variant): { size: string; width: number; height: number; format: string; bytes: number; state: "pending" | "done" | "error" | "failed"; path: string; crop: PixelCrop | null } {
  const rendered = typeof variant.renderedCrop === "string" ? parseCrop(variant.renderedCrop) : null;
  return { size: variant.size, width: variant.width, height: variant.height, format: variant.format, bytes: variant.bytes, state: variant.state === "planned" ? "pending" : variant.state, path: images.publicPath(variant.mediaId, variant), crop: rendered };
}

const ZERO_VARIANT_COUNTS: VariantCounts = { done: 0, pending: 0, error: 0, failed: 0 };
const UNFRAMED: FramingView = { focus: null, crops: {}, width: null, height: null, ratios: [] };

function framingFields(views: Map<string, FramingView>, id: unknown, isEligible: boolean): { focus: FramingView["focus"]; framing: FramingView } {
  const view = isEligible && typeof id === "string" ? (views.get(id) ?? UNFRAMED) : UNFRAMED;
  return { focus: view.focus, framing: view };
}

function framingInput(ctx: Context): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (ctx.payload.focus !== undefined) input.focus = ctx.payload.focus;
  if (ctx.payload.crops !== undefined) input.crops = ctx.payload.crops;
  return input;
}

const SIZE_SCHEMA = { type: "object", properties: { name: { type: "string" }, width: { type: "number" }, height: { type: ["number", "null"] }, fit: { type: "string", enum: ["inside", "cover"] }, format: { type: "string", enum: ["webp", "original"] }, quality: { type: "number" }, source: { type: "string", enum: ["default", "config", "registered"] }, updatedAt: { type: "number" } }, required: ["name", "width", "fit", "format", "quality", "source", "updatedAt"] };
const SIZE_INPUT_SCHEMA = { type: "object", properties: { name: { type: "string" }, width: { type: "integer", minimum: 16, maximum: 8192 }, height: { type: "integer", minimum: 16, maximum: 8192 }, fit: { type: "string", enum: ["inside", "cover"] }, format: { type: "string", enum: ["webp", "original"] }, quality: { type: "integer", minimum: 1, maximum: 100 } }, required: ["name", "width"], additionalProperties: false };
const GENERATE_INPUT_SCHEMA = { type: "object", properties: { id: { type: "string" }, ids: { type: "array", items: { type: "string" } } }, additionalProperties: true, description: "reached either directly (id/ids) or as the media.uploaded / images.planned event envelope, which carries further fields this step ignores" };
const VARIANT_SCHEMA = { type: "object", properties: { id: { type: "string" }, mediaId: { type: "string" }, size: { type: "string" }, slot: { type: "string" }, spec: { type: "string" }, width: { type: "number" }, height: { type: "number" }, format: { type: "string" }, key: { type: "string" }, bytes: { type: "number" }, state: { type: "string", enum: ["planned", "pending", "done", "error", "failed"] }, error: { type: ["string", "null"] }, attempts: { type: "number" }, updatedAt: { type: "number" }, crop: { type: ["string", "null"] }, renderedCrop: { type: ["string", "null"] }, renders: { type: ["number", "null"] }, originalWidth: { type: ["number", "null"] }, originalHeight: { type: ["number", "null"] } }, required: ["id", "mediaId", "size", "slot", "spec", "width", "height", "format", "key", "bytes", "state", "error", "attempts", "updatedAt"] };
const JOB_SCHEMA = { type: "object", properties: { id: { type: "string" }, state: { type: "string", enum: ["running", "paused", "done", "error"] }, total: { type: "number" }, done: { type: "number" }, failed: { type: "number" }, cursor: { type: "string" }, startedAt: { type: "number" }, updatedAt: { type: "number" }, finishedAt: { type: ["number", "null"] }, error: { type: ["string", "null"] } }, required: ["id", "state", "total", "done", "failed", "cursor", "startedAt", "updatedAt", "finishedAt", "error"] };
const FAILED_VARIANT_SCHEMA = { type: "object", properties: { mediaId: { type: "string" }, size: { type: "string" }, attempts: { type: "number" }, error: { type: ["string", "null"] }, updatedAt: { type: "number" } }, required: ["mediaId", "size", "attempts", "error", "updatedAt"] };
const PIXEL_CROP_SCHEMA = { type: "object", properties: { left: { type: "number" }, top: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["left", "top", "width", "height"] };
const ATTACHED_VARIANT_SCHEMA = { type: "object", properties: { size: { type: "string" }, width: { type: "number" }, height: { type: "number" }, format: { type: "string" }, bytes: { type: "number" }, state: { type: "string", enum: ["pending", "done", "error", "failed"] }, path: { type: "string" }, crop: { oneOf: [PIXEL_CROP_SCHEMA, { type: "null" }], description: "the crop of the oriented original that the bytes at path show; null for the whole image or the centred cut of the size's ratio, up to a pixel per edge" } }, required: ["size", "width", "height", "format", "bytes", "state", "path", "crop"] };
const VARIANT_COUNTS_SCHEMA = { type: "object", properties: { done: { type: "number" }, pending: { type: "number" }, error: { type: "number" }, failed: { type: "number" } }, required: ["done", "pending", "error", "failed"] };
const RECT_SCHEMA = { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 }, w: { type: "number", minimum: 0, maximum: 1 }, h: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y", "w", "h"], additionalProperties: false };
const FRAMING_PROPERTIES = { focus: { oneOf: [RECT_SCHEMA, { type: "null" }] }, crops: { type: "object", additionalProperties: RECT_SCHEMA, description: "manual crops keyed by reduced ratio, e.g. \"16:9\"" } };
const FRAMING_SCHEMA = { type: "object", properties: FRAMING_PROPERTIES, required: ["focus", "crops"] };
const FRAMING_INPUT_SCHEMA = { type: "object", properties: FRAMING_PROPERTIES, additionalProperties: false };
const FRAMING_RATIO_SCHEMA = { type: "object", properties: { key: { type: "string" }, sizes: { type: "array", items: { type: "string" } }, manual: { type: "boolean" }, fits: { type: "boolean" }, crop: { oneOf: [PIXEL_CROP_SCHEMA, { type: "null" }] } }, required: ["key", "sizes", "manual", "fits", "crop"] };
const FRAMING_VIEW_SCHEMA = { type: "object", properties: { ...FRAMING_PROPERTIES, width: { type: ["integer", "null"], minimum: 1, description: "width of the original after its EXIF orientation, which the rectangles and pixel crops refer to" }, height: { type: ["integer", "null"], minimum: 1, description: "height of the original after its EXIF orientation" }, ratios: { type: "array", items: FRAMING_RATIO_SCHEMA } }, required: ["focus", "crops", "width", "height", "ratios"] };
const PUBLIC_SYNC_SCHEMA = { type: "object", properties: { written: { type: "number" }, removed: { type: "number" }, planned: { type: "number" }, missing: { type: "number" } }, required: ["written", "removed", "planned", "missing"] };

export default defineModule({
  name: "images/default",
  provides: [],
  requires: [BLOBSTORE, PERSISTENCE, MEDIA],
  optional: [EVENTS],
  emits: ["images.variantsChanged"],
  configSchema,

  async setup(config, deps): Promise<Images> {
    const bus = deps.find(EVENTS);
    const db = ownedPersistence(deps.get(PERSISTENCE), "images/default", COLLECTIONS);
    return createImages(config, { blobs: deps.get(BLOBSTORE), db, media: deps.get(MEDIA), logger: deps.logger, ...(bus ? { events: bus } : {}) });
  },

  attach: (images, kestrel) => images.attach(kestrel),

  steps: (images) => ({
    register: async (ctx: Context) => {
      const sizes = await images.register(ctx.payload.sizes);
      if (isErr(sizes)) return ctx.fail(sizes.error);
      return ok({ ...ctx, result: sizes.value });
    },

    listSizes: async (ctx: Context) => ok({ ...ctx, result: await images.sizes() }),

    plan: async (ctx: Context) => {
      const ids = mediaIds(ctx);
      if (ids) {
        const planned = await images.plan(ids);
        if (isErr(planned)) return ctx.fail(planned.error);
        return ok({ ...ctx, result: { ids } });
      }
      const id = mediaId(ctx);
      if (!id) return ctx.fail("VALIDATION", "images: missing media id");
      const planned = await images.plan([id]);
      if (isErr(planned)) return ctx.fail(planned.error);
      return ok({ ...ctx, result: { id } });
    },

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

    retryFailed: async (ctx: Context) => {
      const id = mediaId(ctx);
      if (id !== undefined) {
        const known = await images.exists(id);
        if (isErr(known)) return ctx.fail(known.error);
        if (!known.value) return ctx.fail("NOT_FOUND", `images: media/${id} not found`);
      }
      const retried = await images.retryFailed(id);
      if (isErr(retried)) return ctx.fail(retried.error);
      return ok({ ...ctx, result: retried.value });
    },

    prune: async (ctx: Context) => {
      const names = ctx.payload.sizes;
      if (!Array.isArray(names) || !names.every((name): name is string => typeof name === "string")) return ctx.fail("VALIDATION", "images: missing sizes");
      const pruned = await images.prune(names);
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
      for (const id of resultIds(ctx, "removeMany")) {
        const removed = await images.remove(id);
        if (isErr(removed)) return ctx.fail(removed.error);
      }
      return ok(ctx);
    },

    hideMany: async (ctx: Context) => {
      const hidden = await images.hide(resultIds(ctx, "hideMany"), resultVersions(ctx));
      if (isErr(hidden)) return ctx.fail(hidden.error);
      return ok(ctx);
    },

    showMany: async (ctx: Context) => {
      const shown = await images.show(resultIds(ctx, "showMany"), resultVersions(ctx));
      if (isErr(shown)) return ctx.fail(shown.error);
      return ok(ctx);
    },

    setFraming: async (ctx: Context) => {
      const id = ctx.params.id;
      if (!id) return ctx.fail("VALIDATION", "images: missing id");
      const framed = await images.setFraming(id, framingInput(ctx));
      if (isErr(framed)) return ctx.fail(framed.error);
      return ok({ ...ctx, result: framed.value });
    },

    attach: async (ctx: Context) => {
      const result = boundaryCast<{ id?: unknown; items?: unknown } | undefined>(ctx.result, "host");
      if (typeof result?.id === "string") {
        const byMedia = await images.variantsOf([result.id]);
        if (isErr(byMedia)) return ctx.fail(byMedia.error);
        const views = await images.framingsOf([result.id]);
        if (isErr(views)) return ctx.fail(views.error);
        const counts = await images.variantCounts([result.id]);
        if (isErr(counts)) return ctx.fail(counts.error);
        const hidden = await images.hidden([result.id]);
        if (isErr(hidden)) return ctx.fail(hidden.error);
        const rows = hidden.value.has(result.id) ? [] : (byMedia.value.get(result.id) ?? []);
        const contentType = boundaryCast<{ contentType?: unknown }>(result, "host").contentType;
        const isEligible = typeof contentType !== "string" || eligible(contentType);
        const available = !hidden.value.has(result.id) && (!isEligible || (rows.length > 0 && rows.every((v) => v.state !== "planned")));
        const variants = rows.filter((v) => v.state !== "planned").map((v) => attachedVariant(images, v));
        return ok({ ...ctx, result: { ...result, available, variants, variantCounts: counts.value.get(result.id) ?? ZERO_VARIANT_COUNTS, ...framingFields(views.value, result.id, isEligible) } });
      }
      if (Array.isArray(result?.items)) {
        const items = boundaryCast<Array<Record<string, unknown>>>(result.items, "host");
        const ids = items.map((item) => item.id).filter((id): id is string => typeof id === "string");
        const byMedia = await images.variantsOf(ids);
        if (isErr(byMedia)) return ctx.fail(byMedia.error);
        const views = await images.framingsOf(ids);
        if (isErr(views)) return ctx.fail(views.error);
        const counts = await images.variantCounts(ids);
        if (isErr(counts)) return ctx.fail(counts.error);
        const hidden = await images.hidden(ids);
        if (isErr(hidden)) return ctx.fail(hidden.error);
        const withVariants = items.map((item) => {
          const isHidden = typeof item.id === "string" && hidden.value.has(item.id);
          const rows = typeof item.id === "string" && !isHidden ? (byMedia.value.get(item.id) ?? []) : [];
          const itemCounts = typeof item.id === "string" ? (counts.value.get(item.id) ?? ZERO_VARIANT_COUNTS) : ZERO_VARIANT_COUNTS;
          const isEligible = typeof item.contentType !== "string" || eligible(item.contentType);
          const available = !isHidden && (!isEligible || (rows.length > 0 && rows.every((v) => v.state !== "planned")));
          const variants = rows.filter((v) => v.state !== "planned").map((v) => attachedVariant(images, v));
          return { ...item, available, variants, variantCounts: itemCounts, ...framingFields(views.value, item.id, isEligible) };
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
      if (found.value === null) return ctx.fail("NOT_FOUND", `images: media/${id}/variants/${file} not found`);
      const result = binaryResult(found.value.data, found.value.contentType, file);
      if (found.value.fallback) result.headers = { "x-kestrel-variant": found.value.variant };
      return ok({ ...ctx, result });
    },

    syncPublic: async (ctx: Context) => {
      const synced = await images.syncPublic();
      if (isErr(synced)) return ctx.fail(synced.error);
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, _publicVariants: synced.value } });
    },

    export: stepFactory((dir: string) => async (ctx: Context) => {
      const variants = await images.exportTo(dir);
      if (isErr(variants)) return ctx.fail(variants.error);
      const previous = isRecord(ctx.result) ? ctx.result : {};
      return ok({ ...ctx, result: { ...previous, variants: variants.value } });
    }),
  }),

  teardown: (images) => images.close(),

  describe: (images) => ({
    register: { summary: "Replace the sizes registered by this instance – code-declared sizes are held in memory, never stored", reads: [], writes: ["result"], input: { type: "object", properties: { sizes: { type: "array", items: SIZE_INPUT_SCHEMA } }, required: ["sizes"], additionalProperties: false }, output: { type: "array", items: SIZE_SCHEMA }, errors: { 400: "empty list or invalid size definition", 409: "a size collides with a config size" } },
    listSizes: { summary: "Effective sizes (defaults/config merged with the sizes registered in this process)", reads: [], writes: ["result"], output: { type: "array", items: SIZE_SCHEMA } },
    plan: { summary: "Decide every effective size's format, extension, dimensions and path for one media item (id from params.id or payload.id), or for each id in payload.ids, and make its public copies answer with the original's bytes; never renders", reads: [], writes: ["result"], input: GENERATE_INPUT_SCHEMA, output: { oneOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] }] }, errors: { 400: "missing media id" } },
    generate: { summary: "Generate variants for one media item (id from params.id or payload.id), or for each id in payload.ids (unknown ids are skipped)", reads: [], writes: ["result"], input: GENERATE_INPUT_SCHEMA, output: { oneOf: [{ type: "object", properties: { id: { type: "string" }, variants: { type: "array", items: VARIANT_SCHEMA } }, required: ["id", "variants"] }, { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, variants: { type: "array", items: VARIANT_SCHEMA } }, required: ["id", "variants"] } } }, required: ["items"] }] }, errors: { 400: "missing media id", 404: "media item not found or not ready" } },
    sync: { summary: "Start a sync job, or resume a paused/error/stale one", reads: [], writes: ["result"], output: JOB_SCHEMA, errors: { 409: "a fresh job is already running" } },
    resume: { summary: "Place and render any item left unfinished (a repair pass), then resume a paused/error/stale sync job, or no-op (for cron)", reads: [], writes: ["result"], output: { oneOf: [JOB_SCHEMA, { type: "null" }] }, errors: { 409: "images are shutting down" } },
    retryFailed: {
      summary: "Put every variant that gave up after maxAttempts back to pending with a fresh attempt budget – all of them, or one media item's (id from params.id or payload.id) – and start the work that regenerates them",
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
      output: { type: "object", properties: { variants: { type: "number" }, media: { type: "number" }, job: { oneOf: [JOB_SCHEMA, { type: "null" }] } }, required: ["variants", "media", "job"] },
      errors: { 404: "media item not found or not ready", 409: "images are shutting down" },
    },
    prune: { summary: "Retire the variants of sizes that are no longer declared: their paths keep answering with the original's bytes until the item is deleted", reads: [], writes: ["result"], input: { type: "object", properties: { sizes: { type: "array", items: { type: "string" } } }, required: ["sizes"], additionalProperties: false }, output: { type: "object", properties: { sizes: { type: "number" }, variants: { type: "number" } }, required: ["sizes", "variants"] }, errors: { 400: "missing sizes, or a name is still declared or has no variants" } },
    readStatus: {
      summary: "Sizes with usage/variant counts, current job, the variants that gave up with their last error, and sizes whose variants are left over from a size the code no longer declares",
      reads: [],
      writes: ["result"],
      output: {
        type: "object",
        properties: {
          sizes: { type: "array", items: { type: "object", properties: { ...SIZE_SCHEMA.properties, used: { type: "boolean" }, variants: { type: "object", properties: { done: { type: "number" }, pending: { type: "number" }, error: { type: "number" }, failed: { type: "number" } }, required: ["done", "pending", "error", "failed"] } }, required: [...SIZE_SCHEMA.required, "used", "variants"] } },
          job: { oneOf: [JOB_SCHEMA, { type: "null" }] },
          orphaned: { type: "object", properties: { sizes: { type: "array", items: { type: "string" } }, variants: { type: "number" } }, required: ["sizes", "variants"] },
          registrySeen: { type: "boolean" },
          failed: { type: "object", properties: { variants: { type: "number" }, recent: { type: "array", items: FAILED_VARIANT_SCHEMA } }, required: ["variants", "recent"] },
        },
        required: ["sizes", "job", "orphaned", "registrySeen", "failed"],
      },
    },
    remove: { summary: "Delete one media item's variants and retired paths (blob + rows)", reads: ["params.id"], writes: [], errors: { 400: "missing id" } },
    removeMany: { summary: "Delete variants for every id in result.ids (from media.listFolderItems, media.removeFolder or media.purge)", reads: ["result.ids"], writes: [] },
    hideMany: { summary: "Hide the variants of every id in result.ids (from media.trash or media.trashFolder): their public copies are removed and their paths are neither served, exported nor copied again until images.showMany, while rows and stored variants stay; raises no images.variantsChanged; with result.trashVersions (from the same steps), an id whose variants a later move already showed is left alone", reads: ["result.ids", "result.trashVersions?"], writes: [] },
    showMany: { summary: "Show the variants of every id in result.ids again (from media.restore) and write their public copies; raises no images.variantsChanged; with result.trashVersions, an id whose variants a later move already hid stays hidden", reads: ["result.ids", "result.trashVersions?"], writes: [] },
    setFraming: {
      summary: "Replace the framing of one media item (params.id): a focus rectangle and manual crops keyed by reduced ratio, normalised to 0..1 on the oriented original; an empty one removes it. Re-plans the item, so each cover size whose crop changes renders again at its path while the old variant keeps being served; raises images.variantsChanged when the focus changes",
      reads: ["params.id"],
      writes: ["result"],
      input: FRAMING_INPUT_SCHEMA,
      output: { type: "object", properties: { id: { type: "string" }, framing: FRAMING_SCHEMA }, required: ["id", "framing"] },
      errors: { 400: "missing id, or an invalid focus or crop", 404: "media item not found, not ready, hidden or without variants" },
    },
    attach: {
      summary: "Add available, variants[], variantCounts, focus and framing to a media item or list (result.id or result.items); a variant whose path has no object yet is never listed, a hidden item lists no variants and is not available, and framing.ratios has one entry per ratio of the cover sizes",
      reads: ["result"],
      writes: ["result.available?", "result.variants?", "result.variantCounts?", "result.focus?", "result.framing?"],
      extendsItems: { type: "object", properties: { available: { type: "boolean" }, variants: { type: "array", items: ATTACHED_VARIANT_SCHEMA }, variantCounts: VARIANT_COUNTS_SCHEMA, focus: { oneOf: [RECT_SCHEMA, { type: "null" }] }, framing: FRAMING_VIEW_SCHEMA }, required: ["available", "variants", "variantCounts", "focus", "framing"] },
    },
    serve: images.publicCopyEnabled()
      ? {
          summary: "The variant at its public URL (params.id, params.file), or the original's bytes when no render is at that path yet; x-kestrel-variant: original marks the fallback",
          reads: ["params.id", "params.file"],
          writes: ["result"],
          binary: true,
          errors: { 400: "missing id or file", 404: "media item not found, not ready or hidden, or the file is neither a current nor a retired size" },
          anonymous: "required" as const,
        }
      : {
          summary: "The variant at its public URL (params.id, params.file), or the original's bytes when no render is at that path yet; x-kestrel-variant: original marks the fallback",
          reads: ["params.id", "params.file"],
          writes: ["result"],
          binary: true,
          errors: { 400: "missing id or file", 404: "media item not found, not ready or hidden, or the file is neither a current nor a retired size" },
        },
    syncPublic: {
      summary: "Reconcile the public copies of every ready item's variants and retired paths with the stored rows: place missing sizes, write missing or mismatched copies, and remove copies of deleted or hidden items and foreign files (adds _publicVariants: { written, removed, planned, missing } to the result)",
      reads: [],
      writes: ["result._publicVariants"],
      extendsOutput: { type: "object", properties: { _publicVariants: PUBLIC_SYNC_SCHEMA }, required: ["_publicVariants"] },
    },
    export: (dir: string) => ({ summary: `Copy every done variant of a ready, not hidden media item to ${dir}/<folder>/<filename>.<size>.<ext>`, reads: [], writes: ["result.variants"], extendsOutput: { type: "object", properties: { variants: { type: "object", properties: { written: { type: "number" }, skipped: { type: "number" } }, required: ["written", "skipped"] } }, required: ["variants"] } }),
  }),
});
