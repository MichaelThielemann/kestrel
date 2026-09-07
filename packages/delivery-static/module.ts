import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE } from "@michaelthielemann/kestrel-contracts/site";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createDeliveryStatic, type Delivery } from "./impl.ts";

export const configSchema = z
  .object({
    types: z.record(
      z.object({ slugField: z.string().default("slug"), statusField: z.string().default("status"), publishedValue: z.string().default("published"), home: z.string().default("home") }).strict(),
    ),
    formats: z.array(z.string().min(1)).min(1).default(["html"]),
    prefix: z.string().default(""),
    prefixPrimary: z.boolean().default(false),
    fallback: z.boolean().default(true),
    media: z
      .object({
        publicPath: z.string().regex(/^\/[A-Za-z0-9._/-]*$/).default("/media"),
        collection: z.string().default("media_items"),
        variants: z.string().default("images_variants"),
        target: z.string().regex(/^([A-Za-z0-9._-]+\/)+$/).default("media/"),
      })
      .strict()
      .optional(),
    llms: z
      .object({
        siteUrl: z.string().url().optional(),
        full: z.boolean().default(false),
        settings: z.object({ type: z.string().default("settings"), titleField: z.string().default("title"), descriptionField: z.string().default("description") }).strict().default({}),
        titleField: z.string().default("title"),
        seoField: z.string().default("seo"),
        headings: z.record(z.string()).default({}),
      })
      .strict()
      .default({}),
  })
  .strict();

function documentId(ctx: Context, step: string): string {
  const result = ctx.result as { id?: unknown } | undefined;
  if (typeof result?.id !== "string") throw new Error(`delivery/static: ${step} ran without a document id in result`);
  return result.id;
}

const STATUS_SCHEMA = {
  type: "object",
  properties: { type: { type: "string" }, docId: { type: "string" }, locale: { type: "string" }, state: { type: "string", enum: ["live", "error", "draft"] }, path: { type: ["string", "null"] }, error: { type: ["string", "null"] }, publishedAt: { type: ["number", "null"] }, updatedAt: { type: "number" } },
  required: ["type", "docId", "locale", "state", "updatedAt"],
};

export default defineModule({
  name: "delivery/static",
  provides: [],
  requires: [CONTENT, RENDERER, BLOBSTORE, PERSISTENCE, SITE],
  configSchema,

  async setup(config, deps): Promise<Delivery> {
    return createDeliveryStatic(config, { content: deps.get(CONTENT), site: deps.get(SITE), renderer: deps.get(RENDERER), blobs: deps.get(BLOBSTORE), db: deps.get(PERSISTENCE), logger: deps.logger });
  },

  steps: (delivery) => ({
    publish: stepFactory((type: string) => async (ctx: Context) => {
      const published = await delivery.publish(type, documentId(ctx, `delivery.publish:${type}`));
      if (isErr(published)) return ctx.fail(published.error);
      return ok({ ...ctx, result: { document: ctx.result, delivery: published.value } });
    }),
    unpublish: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await delivery.unpublish(type, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    }),
    readStatus: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const rows = await delivery.status(type, ctx.params.id);
      if (isErr(rows)) return ctx.fail(rows.error);
      return ok({ ...ctx, result: rows.value });
    }),
    publishAll: stepFactory((type: string) => async (ctx: Context) => {
      const summary = await delivery.publishAll(type);
      if (isErr(summary)) return ctx.fail(summary.error);
      return ok({ ...ctx, result: summary.value });
    }),
    exportLlms: async (ctx: Context) => {
      const previous = typeof ctx.result === "object" && ctx.result !== null && !Array.isArray(ctx.result) ? (ctx.result as Record<string, unknown>) : {};
      const exported = await delivery.exportLlms();
      if (isErr(exported)) return ctx.fail("TRANSIENT", `delivery.exportLlms: llms.txt was not written – try again (${exported.error.message})`);
      return ok({ ...ctx, result: { ...previous, llms: exported.value } });
    },
  }),

  describe: () => ({
    publish: (type: string) => ({
      summary: `Render and store published locales of a ${type}`,
      reads: ["result.id"],
      writes: ["result"],
      output: { type: "object", properties: { document: { type: "object" }, delivery: { type: "array", items: STATUS_SCHEMA } } },
    }),
    unpublish: (type: string) => ({ summary: `Remove rendered output of a ${type}`, reads: ["params.id"], writes: [], errors: { 400: "missing id" } }),
    readStatus: (type: string) => ({ summary: `Publish status per locale of a ${type}`, reads: ["params.id"], writes: ["result"], output: { type: "array", items: STATUS_SCHEMA }, errors: { 400: "missing id" } }),
    publishAll: (type: string) => ({
      summary: `Re-render every ${type}`,
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { documents: { type: "number" }, live: { type: "number" }, errors: { type: "number" } } },
    }),
    exportLlms: {
      summary: "Write llms.txt (and llms-full.txt when `llms.full` is set) from the live output of every delivered type (adds `llms: { entries, full }` to the result)",
      reads: [],
      writes: ["result.llms"],
      extendsOutput: { type: "object", properties: { llms: { type: "object", properties: { entries: { type: "integer" }, full: { type: "boolean" } }, required: ["entries", "full"] } }, required: ["llms"] },
    },
  }),
});
