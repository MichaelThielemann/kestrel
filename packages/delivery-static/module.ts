import { z } from "zod";
import { BLOBSTORE } from "@michaelthielemann/kestrel-contracts/blobstore";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { RENDERER } from "@michaelthielemann/kestrel-contracts/renderer";
import { SITE } from "@michaelthielemann/kestrel-contracts/site";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type Introspection } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createDeliveryStatic, INDEXES_STALE, LLMS_STALE, normalizeSiteUrl, OUTPUT_STALE, type Delivery, type MovedPath } from "./impl.ts";

const dependenciesSchema = z
  .object({
    render: z.enum(["events", "background"]).default("background"),
    rendererReadsDocument: z.boolean().default(false),
    maxPerRender: z.number().int().positive().default(1000),
    renderTimeoutSeconds: z.number().int().positive().default(60),
    maxAttempts: z.number().int().positive().default(5),
    backoffSeconds: z.array(z.number().int().nonnegative()).min(1).default([60, 300, 900, 3600]),
    claimTtlSeconds: z.number().int().positive().default(300),
    maxAgeSeconds: z.number().int().positive().nullable().default(null),
    indexesDelayMs: z.number().int().nonnegative().default(1000),
  })
  .strict();

const siteUrlSchema = z.string().superRefine((value, ctx) => {
  try {
    normalizeSiteUrl(value);
  } catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
  }
});

export const configSchema = z
  .object({
    types: z.record(
      z.string(),
      z.object({ slugField: z.string().default("slug"), statusField: z.string().default("status"), publishedValue: z.string().default("published"), home: z.string().optional() }).strict(),
    ),
    formats: z.array(z.string().min(1)).min(1).default(["html"]),
    prefix: z.string().default(""),
    prefixPrimary: z.boolean().default(false),
    fallback: z.boolean().default(true),
    reservedPaths: z.array(z.string().regex(/^(\/[A-Za-z0-9._-]+)+$/)).default([]),
    siteUrl: siteUrlSchema.optional(),
    sitemap: z.boolean().default(true),
    robots: z
      .union([
        z.literal(false),
        z
          .object({
            policy: z.enum(["allow", "disallow"]).optional(),
            extra: z.array(z.string().regex(/^[^\r\n]*$/, "a robots.txt line must not contain a line break")).default([]),
          })
          .strict(),
      ])
      .prefault({}),
    llms: z
      .object({
        full: z.boolean().default(false),
        settings: z.object({ type: z.string().default("settings"), titleField: z.string().default("title"), descriptionField: z.string().default("description") }).strict().prefault({}),
        titleField: z.string().default("title"),
        seoField: z.string().default("seo"),
        headings: z.record(z.string(), z.string()).default({}),
      })
      .strict()
      .prefault({}),
    dependencies: dependenciesSchema.prefault({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    const { renderTimeoutSeconds, claimTtlSeconds } = value.dependencies;
    const formats = value.formats.length;
    if (renderTimeoutSeconds * formats >= claimTtlSeconds) {
      ctx.addIssue({ code: "custom", path: ["dependencies", "renderTimeoutSeconds"], message: `dependencies.renderTimeoutSeconds (${renderTimeoutSeconds}) times the ${formats} format(s) must be below dependencies.claimTtlSeconds (${claimTtlSeconds})` });
    }
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documentId(ctx: Context): string | null {
  const result = boundaryCast<{ id?: unknown } | undefined>(ctx.result, "host");
  if (typeof result?.id === "string") return result.id;
  return typeof ctx.payload.id === "string" ? ctx.payload.id : null;
}

function changedIds(payload: Record<string, unknown>): string[] {
  const ids = Array.isArray(payload.ids) ? payload.ids.filter((v): v is string => typeof v === "string") : [];
  if (typeof payload.id === "string") ids.push(payload.id);
  return [...new Set(ids)];
}

function isMovedPath(value: unknown): value is MovedPath {
  return isRecord(value) && typeof value.type === "string" && typeof value.id === "string" && typeof value.locale === "string" && (value.from === null || typeof value.from === "string") && (value.to === null || typeof value.to === "string");
}

function previousResult(ctx: Context): Record<string, unknown> {
  return isRecord(ctx.result) ? ctx.result : {};
}

type Instance = Delivery & { render: "events" | "background"; llmsFull: boolean };

function checkEventsWiring(kestrel: Introspection, llmsFull: boolean): void {
  const manifest = kestrel.describe();
  const stepsOf = new Map(manifest.pipelines.map((p) => [p.name, p.steps.map((s) => s.name)]));
  const subscribed = (event: string, step: string): boolean => manifest.triggers.events.some((t) => t.event === event && (stepsOf.get(t.pipeline) ?? []).includes(step));
  const required: Array<[string, string]> = [
    [OUTPUT_STALE, "delivery.republishOutput"],
    [INDEXES_STALE, "delivery.exportIndexes"],
    ...(llmsFull ? [[LLMS_STALE, "delivery.exportLlmsFull"] satisfies [string, string]] : []),
  ];
  for (const [event, step] of required) if (!subscribed(event, step)) throw new Error(`delivery/static: dependencies.render "events" needs a trigger that runs a pipeline with ${step} on "${event}"`);
  const hook = manifest.modules.find((m) => m.eventHook);
  if (hook?.name === "events/direct") throw new Error('delivery/static: dependencies.render "events" would run every re-render inside the request that marked it under events/direct; use "background" or the queue');
}

const ENVELOPE_INPUT = { type: "object", additionalProperties: true };
const NULLABLE_NUMBER = { type: ["number", "null"] };
const NULLABLE_STRING = { type: ["string", "null"] };
const STATE = { type: "string", enum: ["live", "error", "draft"] };

const STATUS_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string" },
    docId: { type: "string" },
    locale: { type: "string" },
    state: STATE,
    path: NULLABLE_STRING,
    error: NULLABLE_STRING,
    publishedAt: NULLABLE_NUMBER,
    updatedAt: { type: "number" },
    stale: { type: "boolean" },
    staleSince: NULLABLE_NUMBER,
    staleFailed: { type: "boolean" },
    staleError: NULLABLE_STRING,
    dependencies: NULLABLE_NUMBER,
  },
  required: ["type", "docId", "locale", "state", "updatedAt", "stale", "staleSince", "staleFailed", "staleError", "dependencies"],
};

const MARKED = { type: "object", properties: { marked: { type: "integer" } }, required: ["marked"] };

const EXPORT_OUTCOME = { type: ["object", "null"], properties: { at: { type: "number" }, entries: { type: "integer" }, error: NULLABLE_STRING, skipped: { type: "boolean" } }, required: ["at", "entries", "error", "skipped"] };

const STALE_STATUS_SCHEMA = {
  type: "object",
  properties: {
    stale: { type: "integer" },
    failed: { type: "integer" },
    rendering: { type: "integer" },
    unknown: { type: "integer" },
    oldestStaleAt: NULLABLE_NUMBER,
    abandoned: { type: "integer" },
    exports: { type: "object", properties: { indexes: EXPORT_OUTCOME, llmsFull: EXPORT_OUTCOME }, required: ["indexes", "llmsFull"] },
  },
  required: ["stale", "failed", "rendering", "unknown", "oldestStaleAt", "abandoned", "exports"],
};

const ENTRIES = { type: "object", properties: { entries: { type: "integer" } }, required: ["entries"] };

export default defineModule({
  name: "delivery/static",
  provides: [],
  requires: [CONTENT, RENDERER, BLOBSTORE, PERSISTENCE, SITE],
  optional: [EVENTS],
  emits: [OUTPUT_STALE, INDEXES_STALE, LLMS_STALE],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    const delivery = await createDeliveryStatic(config, { content: deps.get(CONTENT), site: deps.get(SITE), renderer: deps.get(RENDERER), blobs: deps.get(BLOBSTORE), db: deps.get(PERSISTENCE), logger: deps.logger, events: deps.find(EVENTS) });
    return { ...delivery, render: config.dependencies.render, llmsFull: config.llms.full };
  },

  attach: (instance, kestrel) => {
    if (instance.render === "events") checkEventsWiring(kestrel, instance.llmsFull);
  },

  teardown: async (instance) => {
    await instance.close();
  },

  steps: (delivery) => ({
    publish: stepFactory((type: string) => async (ctx: Context) => {
      const id = documentId(ctx);
      if (id === null) return ctx.fail("VALIDATION", "delivery.publish: no document id in the result or the event payload");
      const published = await delivery.publish(type, id);
      if (isErr(published)) return ctx.fail(published.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), _delivery: published.value } });
    }),
    unpublish: stepFactory((type: string) => async (ctx: Context) => {
      const id = ctx.params.id ?? (typeof ctx.payload.id === "string" ? ctx.payload.id : undefined);
      if (!id) return ctx.fail("VALIDATION", "delivery.unpublish: no document id in params or the event payload");
      const removed = await delivery.unpublish(type, id);
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
    exportIndexes: async (ctx: Context) => {
      const exported = await delivery.exportIndexes();
      if (isErr(exported)) return ctx.fail("TRANSIENT", `delivery.exportIndexes: sitemap.xml, robots.txt and llms.txt were not written – try again (${exported.error.message})`);
      return ok({ ...ctx, result: { ...previousResult(ctx), _indexes: exported.value } });
    },
    exportLlmsFull: async (ctx: Context) => {
      const exported = await delivery.exportLlmsFull();
      if (isErr(exported)) return ctx.fail("TRANSIENT", `delivery.exportLlmsFull: llms-full.txt was not written – try again (${exported.error.message})`);
      return ok({ ...ctx, result: { ...previousResult(ctx), _llmsFull: exported.value } });
    },
    markDependents: stepFactory((type: string) => async (ctx: Context) => {
      const marked = await delivery.markDependents(type, changedIds(ctx.payload));
      if (isErr(marked)) return ctx.fail(marked.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), _dependents: marked.value } });
    }),
    markMoved: async (ctx: Context) => {
      const moves: unknown = ctx.payload.moves;
      if (!Array.isArray(moves) || !moves.every(isMovedPath)) return ctx.fail("VALIDATION", "delivery.markMoved: payload.moves must be a list of { type, id, locale, from, to }");
      const marked = await delivery.markMoved(moves);
      if (isErr(marked)) return ctx.fail(marked.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), _moved: marked.value } });
    },
    markAll: stepFactory((type: string) => async (ctx: Context) => {
      const marked = await delivery.markAll(type);
      if (isErr(marked)) return ctx.fail(marked.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), ...marked.value } });
    }),
    checkBuild: async (ctx: Context) => {
      const build = ctx.payload.build;
      if (typeof build !== "string" || build === "") return ctx.fail("VALIDATION", "delivery.checkBuild: payload.build must be a non-empty string");
      const restoredAt = isRecord(ctx.result) ? ctx.result._databaseRestoredAt : undefined;
      const checked = await delivery.checkBuild(build, typeof restoredAt === "number" ? restoredAt : null);
      if (isErr(checked)) return ctx.fail(checked.error);
      return ok({ ...ctx, result: checked.value });
    },
    republishOutput: async (ctx: Context) => {
      const { type, docId, locale } = ctx.payload;
      if (typeof type !== "string" || typeof docId !== "string" || typeof locale !== "string") return ctx.fail("VALIDATION", "delivery.republishOutput: payload needs type, docId and locale");
      const rendered = await delivery.republishOutput({ type, docId, locale });
      if (isErr(rendered)) return ctx.fail(rendered.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), ...rendered.value } });
    },
    requestIndexes: async (ctx: Context) => {
      const requested = await delivery.requestIndexes();
      if (isErr(requested)) return ctx.fail(requested.error);
      return ok(ctx);
    },
    resumeStale: async (ctx: Context) => {
      const resumed = await delivery.resumeStale();
      if (isErr(resumed)) return ctx.fail(resumed.error);
      return ok({ ...ctx, result: resumed.value });
    },
    retryStale: async (ctx: Context) => {
      const retried = await delivery.retryStale();
      if (isErr(retried)) return ctx.fail(retried.error);
      return ok({ ...ctx, result: { ...previousResult(ctx), ...retried.value } });
    },
    readStaleStatus: async (ctx: Context) => {
      const status = await delivery.readStaleStatus();
      if (isErr(status)) return ctx.fail(status.error);
      return ok({ ...ctx, result: status.value });
    },
  }),

  describe: () => ({
    publish: (type: string) => ({
      summary: `Render and store published locales of a ${type} (adds \`_delivery\` to the result)`,
      reads: ["result.id?", "payload"],
      writes: ["result._delivery"],
      input: ENVELOPE_INPUT,
      extendsOutput: { type: "object", properties: { _delivery: { type: "array", items: STATUS_SCHEMA } }, required: ["_delivery"] },
      errors: { 400: "no document id in the result or the event payload" },
    }),
    unpublish: (type: string) => ({
      summary: `Remove rendered output of a ${type}`,
      reads: ["params.id", "payload"],
      writes: [],
      input: ENVELOPE_INPUT,
      errors: { 400: "no document id in params or the event payload" },
    }),
    readStatus: (type: string) => ({ summary: `Publish status per locale of a ${type}`, reads: ["params.id"], writes: ["result"], output: { type: "array", items: STATUS_SCHEMA }, errors: { 400: "missing id" }, atomicSafe: true }),
    publishAll: (type: string) => ({
      summary: `Re-render every ${type}`,
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { documents: { type: "number" }, live: { type: "number" }, errors: { type: "number" } }, required: ["documents", "live", "errors"] },
    }),
    exportIndexes: {
      summary: "Write sitemap.xml, robots.txt and llms.txt from the outputs that serve a file (live or error) of every delivered type, skipping noindex pages (adds `_indexes: { entries }` to the result)",
      reads: [],
      writes: ["result._indexes"],
      extendsOutput: { type: "object", properties: { _indexes: ENTRIES }, required: ["_indexes"] },
      errors: { 503: "a file could not be written or a dependency failed" },
    },
    exportLlmsFull: {
      summary: "Write llms-full.txt from the stored HTML of the same entries when `llms.full` is set (adds `_llmsFull: { entries }` to the result)",
      reads: [],
      writes: ["result._llmsFull"],
      extendsOutput: { type: "object", properties: { _llmsFull: ENTRIES }, required: ["_llmsFull"] },
      errors: { 503: "the file could not be written or a dependency failed" },
    },
    markDependents: (type: string) => ({
      summary: `Mark every published output whose last render read the changed ${type} (payload id and ids) for a re-render, and start it outside the request (adds \`_dependents: { marked }\` to the result)`,
      reads: ["payload"],
      writes: ["result._dependents"],
      input: ENVELOPE_INPUT,
      extendsOutput: { type: "object", properties: { _dependents: MARKED }, required: ["_dependents"] },
      errors: { 503: "the marks or their jobs could not be written" },
    }),
    markMoved: {
      summary: "Mark the own outputs of every document in payload.moves (site.pathsMoved) and every output linking to one of them for a re-render at its new path, and start it outside the request (adds `_moved: { marked }` to the result)",
      reads: ["payload"],
      writes: ["result._moved"],
      input: { type: "object", properties: { moves: { type: "array", items: { type: "object", properties: { type: { type: "string" }, id: { type: "string" }, locale: { type: "string" }, from: { type: ["string", "null"] }, to: { type: ["string", "null"] } }, required: ["type", "id", "locale", "from", "to"] } } }, required: ["moves"], additionalProperties: true },
      extendsOutput: { type: "object", properties: { _moved: MARKED }, required: ["_moved"] },
      errors: { 400: "payload.moves is missing or malformed", 503: "the marks or their jobs could not be written" },
    },
    markAll: (type: string) => ({
      summary: `Mark every ${type} output for a re-render in the background, including documents that were never delivered (adds \`marked\` to the result)`,
      reads: [],
      writes: ["result"],
      extendsOutput: MARKED,
      errors: { 503: "the marks or their jobs could not be written" },
    }),
    checkBuild: {
      summary: "Mark every delivered output for a re-render when payload.build differs from the stored build or result._databaseRestoredAt, set by an earlier step, names a database restore not handled yet, then store both",
      reads: ["payload", "result._databaseRestoredAt?"],
      writes: ["result"],
      input: { type: "object", properties: { build: { type: "string", minLength: 1 } }, required: ["build"], additionalProperties: true },
      output: { type: "object", properties: { changed: { type: "boolean" }, restored: { type: "boolean" }, marked: { type: "integer" } }, required: ["changed", "restored", "marked"] },
      errors: { 400: "payload.build is missing", 503: "the marks could not be written; the build is not stored" },
    },
    republishOutput: {
      summary: "Render one marked output (payload type, docId, locale) under a claim; a failed render is recorded on the output and answered as an error so the event delivery retries it",
      reads: ["payload"],
      writes: ["result"],
      input: { type: "object", properties: { type: { type: "string" }, docId: { type: "string" }, locale: { type: "string" } }, required: ["type", "docId", "locale"], additionalProperties: true },
      extendsOutput: { type: "object", properties: { rendered: { type: "boolean" }, state: { type: ["string", "null"], enum: ["live", "error", "draft", null] } }, required: ["rendered", "state"] },
      errors: { 400: "payload needs type, docId and locale", 503: "the render failed or another render holds the output" },
    },
    requestIndexes: {
      summary: "Ask for a sitemap.xml, robots.txt and llms.txt export (and an llms-full.txt export with `llms.full`) without running it here",
      reads: [],
      writes: [],
      errors: { 503: 'with dependencies.render "events": the export request could not be queued' },
    },
    resumeStale: {
      summary: "Release expired render claims, remove old tombstones and orphaned dependency sets, start the re-renders a stopped process or a lost job left marked, and ask for an index export",
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { released: { type: "integer" }, swept: { type: "integer" }, dispatched: { type: "integer" }, aged: { type: "integer" }, orphans: { type: "integer" } }, required: ["released", "swept", "dispatched", "aged", "orphans"] },
    },
    retryStale: {
      summary: "Reset the attempts of every output whose re-render failed maxAttempts times and start it again (adds `retried` to the result)",
      reads: [],
      writes: ["result"],
      extendsOutput: { type: "object", properties: { retried: { type: "integer" } }, required: ["retried"] },
    },
    readStaleStatus: {
      summary: "How many outputs wait for a re-render, failed it, are rendering or have unknown dependencies, the oldest mark, the renders this process abandoned at the timeout, and the last index and llms-full.txt exports",
      reads: [],
      writes: ["result"],
      output: STALE_STATUS_SCHEMA,
      atomicSafe: true,
    },
  }),
});
