import { z } from "zod";
import "@michaelthielemann/kestrel-contracts/authn";
import { CONTENT } from "@michaelthielemann/kestrel-contracts/content";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { REVISIONS, type NewRevision, type RevisionAuthor, type Revisions } from "@michaelthielemann/kestrel-contracts/revisions";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule, type JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createRevisionsDefault, documentOf, snapshotFields, statusOf, type RevisionsConfig } from "./impl.ts";

/** The locale recorded when the consumer's content model declares no locales at all. */
export const NO_LOCALE = "*";

export const configSchema = z
  .object({
    keep: z.number().int().positive().default(50),
    maxSnapshotBytes: z.number().int().positive().default(1048576),
    pruneOnWrite: z.boolean().default(true),
    statusField: z.string().min(1).default("status"),
    liveStatuses: z.array(z.string().min(1)).default(["published"]),
    maxLimit: z.number().int().positive().default(100),
  })
  .strict();

type Instance = Revisions & { config: RevisionsConfig; defaultLocale: string };

const AUTHOR_SCHEMA: JsonSchema = { type: "object", properties: { id: { type: ["string", "null"] }, name: { type: ["string", "null"] } }, required: ["id", "name"] };
const SUMMARY_PROPERTIES: Record<string, JsonSchema> = {
  id: { type: "string" },
  collection: { type: "string" },
  documentId: { type: "string" },
  locale: { type: "string" },
  parentId: { type: ["string", "null"] },
  createdAt: { type: "number" },
  author: AUTHOR_SCHEMA,
  kind: { type: "string", enum: ["save", "restore"] },
  label: { type: ["string", "null"] },
  status: { type: ["string", "null"] },
  live: { type: "boolean" },
  bytes: { type: "number" },
  skipped: { type: "boolean" },
};
const SUMMARY_SCHEMA: JsonSchema = { type: "object", properties: SUMMARY_PROPERTIES, required: Object.keys(SUMMARY_PROPERTIES) };
const REVISION_SCHEMA: JsonSchema = { type: "object", properties: { ...SUMMARY_PROPERTIES, snapshot: { type: ["object", "null"] } }, required: [...Object.keys(SUMMARY_PROPERTIES), "snapshot"] };
const PAGE_SCHEMA: JsonSchema = { type: "object", properties: { items: { type: "array", items: SUMMARY_SCHEMA }, total: { type: "number" }, head: { type: ["string", "null"] } }, required: ["items", "total", "head"] };
const REPORT_SCHEMA: JsonSchema = { type: "object", properties: { inspected: { type: "number" }, removed: { type: "number" } }, required: ["inspected", "removed"] };
const LABEL_SCHEMA: JsonSchema = { type: "object", properties: { label: { type: ["string", "null"], maxLength: 200 } }, required: ["label"], additionalProperties: false };
const LOCALE_QUERY: Record<string, JsonSchema> = { locale: { type: "string" } };

function localeOf(ctx: Context, fallback: string): string {
  return ctx.params.locale ?? first(ctx.payload.locale) ?? fallback;
}

function authorOf(ctx: Context): RevisionAuthor {
  if (!ctx.identity) return { id: null, name: null };
  const username = ctx.identity.claims.username;
  const name = ctx.identity.claims.name;
  return { id: ctx.identity.id, name: typeof username === "string" ? username : typeof name === "string" ? name : null };
}

function countOf(ctx: Context, key: string): number | undefined {
  const raw = ctx.payload[key];
  const value = typeof raw === "number" ? raw : Number(first(raw) ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function labelOf(ctx: Context): string | null {
  const raw = ctx.payload.label;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

export default defineModule({
  name: "revisions/default",
  provides: [REVISIONS],
  requires: [PERSISTENCE],
  // Only to read the default locale of the content model; the history itself is content-agnostic.
  optional: [CONTENT],
  configSchema,

  async setup(config, deps): Promise<Instance> {
    const revisions = await createRevisionsDefault(config, { db: deps.get(PERSISTENCE), logger: deps.logger });
    return { ...revisions, config, defaultLocale: deps.find(CONTENT)?.model().defaultLocale ?? NO_LOCALE };
  },

  steps: (revisions) => ({
    record: stepFactory((collection: string) => async (ctx: Context) => {
      const document = documentOf(ctx.result);
      if (!document || typeof document.id !== "string") throw new Error(`revisions.record:${collection}: no document in result`);
      const fields = snapshotFields(document);
      const { status, live } = statusOf(revisions.config, fields);
      const entry: NewRevision = {
        collection,
        documentId: document.id,
        locale: localeOf(ctx, revisions.defaultLocale),
        fields,
        author: authorOf(ctx),
        kind: ctx.revisionParent === undefined ? "save" : "restore",
        status,
        live,
        ...(ctx.revisionParent === undefined ? {} : { parentId: ctx.revisionParent }),
      };
      const recorded = await revisions.record(entry);
      if (isErr(recorded)) return ctx.fail(recorded.error);
      return ok(ctx);
    }),

    list: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const limit = countOf(ctx, "limit");
      const offset = countOf(ctx, "offset");
      const page = await revisions.list(collection, ctx.params.id, localeOf(ctx, revisions.defaultLocale), {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      });
      if (isErr(page)) return ctx.fail(page.error);
      return ok({ ...ctx, result: page.value });
    }),

    read: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id || !ctx.params.revisionId) return ctx.fail("VALIDATION", "missing id or revisionId");
      const revision = await revisions.read(collection, ctx.params.id, ctx.params.revisionId);
      if (isErr(revision)) return ctx.fail(revision.error);
      if (!revision.value) return ctx.fail("NOT_FOUND", `revisions: no revision "${ctx.params.revisionId}" of ${collection}/${ctx.params.id}`);
      return ok({ ...ctx, result: revision.value });
    }),

    restore: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id || !ctx.params.revisionId) return ctx.fail("VALIDATION", "missing id or revisionId");
      const revision = await revisions.read(collection, ctx.params.id, ctx.params.revisionId);
      if (isErr(revision)) return ctx.fail(revision.error);
      if (!revision.value) return ctx.fail("NOT_FOUND", `revisions: no revision "${ctx.params.revisionId}" of ${collection}/${ctx.params.id}`);
      const snapshot = revision.value.snapshot;
      if (!snapshot) return ctx.fail("CONFLICT", `revisions: revision "${revision.value.id}" was recorded without a snapshot and cannot be restored`, { bytes: revision.value.bytes });
      const fields: Record<string, unknown> = { ...snapshot, ...(revision.value.locale === NO_LOCALE ? {} : { locale: revision.value.locale }) };
      return ok({ ...ctx, body: fields, payload: fields, revisionParent: revision.value.id });
    }),

    label: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id || !ctx.params.revisionId) return ctx.fail("VALIDATION", "missing id or revisionId");
      const labelled = await revisions.label(collection, ctx.params.id, ctx.params.revisionId, labelOf(ctx));
      if (isErr(labelled)) return ctx.fail(labelled.error);
      return ok({ ...ctx, result: labelled.value });
    }),

    prune: async (ctx: Context) => {
      const report = await revisions.prune();
      if (isErr(report)) return ctx.fail(report.error);
      return ok({ ...ctx, result: report.value });
    },

    remove: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await revisions.remove(collection, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    }),

    removeTranslation: stepFactory((collection: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await revisions.remove(collection, ctx.params.id, localeOf(ctx, revisions.defaultLocale));
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok(ctx);
    }),
  }),

  describe: (revisions) => ({
    record: (collection: string) => ({
      summary: `Record the saved ${collection} document from the result as a revision; its parent is the head, or the revision a restore put on the context`,
      reads: ["result"],
      writes: [],
      query: LOCALE_QUERY,
      errors: { 503: "the revision could not be written" },
    }),
    list: (collection: string) => ({
      summary: `Revisions of one ${collection} document and locale, newest first and without snapshots`,
      reads: ["params.id"],
      writes: ["result"],
      query: { ...LOCALE_QUERY, limit: { type: "integer", minimum: 1, maximum: revisions.config.maxLimit }, offset: { type: "integer", minimum: 0 } },
      output: PAGE_SCHEMA,
      errors: { 400: "missing id" },
    }),
    read: (collection: string) => ({
      summary: `One revision of a ${collection} document including its snapshot`,
      reads: ["params.id", "params.revisionId"],
      writes: ["result"],
      output: REVISION_SCHEMA,
      errors: { 400: "missing id or revisionId", 404: "no such revision" },
    }),
    restore: (collection: string) => ({
      summary: `Put a ${collection} revision's snapshot into the body, so the steps behind it save it like any other write and branch the history at that revision`,
      reads: ["params.id", "params.revisionId"],
      writes: ["body", "payload", "revisionParent"],
      errors: { 400: "missing id or revisionId", 404: "no such revision", 409: "the revision carries no snapshot" },
    }),
    label: (collection: string) => ({
      summary: `Name a ${collection} revision, or clear its name with null; a labelled revision is never pruned`,
      reads: ["params.id", "params.revisionId"],
      writes: ["result"],
      input: LABEL_SCHEMA,
      output: SUMMARY_SCHEMA,
      errors: { 400: "missing id or revisionId", 404: "no such revision" },
    }),
    prune: { summary: "Apply the retention rules to every recorded document and locale", reads: [], writes: ["result"], output: REPORT_SCHEMA },
    remove: (collection: string) => ({ summary: `Drop every revision of a ${collection} document, in every locale`, reads: ["params.id"], writes: [], errors: { 400: "missing id" } }),
    removeTranslation: (collection: string) => ({ summary: `Drop the revisions of one locale of a ${collection} document`, reads: ["params.id"], writes: [], query: LOCALE_QUERY, errors: { 400: "missing id" } }),
  }),
});
