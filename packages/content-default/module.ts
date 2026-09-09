import { z } from "zod";
import { CONTENT, type Content, type ContentModel } from "@michaelthielemann/kestrel-contracts/content";
import { documentSchema, fieldSchema } from "@michaelthielemann/kestrel-contracts/content-schema";
import type { JsonSchema } from "@michaelthielemann/kestrel/defineModule";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import type { KestrelError } from "@michaelthielemann/kestrel/errors";
import { isErr, ok, type Result } from "@michaelthielemann/kestrel/result";
import { createContentDefault } from "./impl.ts";

const fieldType = z.enum(["text", "richtext", "number", "boolean", "date", "slug", "json", "enum", "ref"]);
const field = z.union([
  fieldType,
  z.object({ type: fieldType, required: z.boolean().optional(), unique: z.boolean().optional(), localized: z.boolean().optional(), options: z.array(z.string().min(1)).optional(), to: z.string().min(1).optional() }).strict(),
]);

export const configSchema = z
  .object({
    types: z.record(z.object({ kind: z.enum(["single", "multi"]), fields: z.record(field), completeWhen: z.object({ field: z.string().min(1), equals: z.string().min(1) }).strict().optional() }).strict()),
    locales: z.array(z.string().min(1)).optional(),
    defaultLocale: z.string().min(1).optional(),
    maxLimit: z.number().int().min(1).default(200),
  })
  .strict();

type ContentInstance = Content & { maxLimit: number };

function parseTarget(arg: string): { type: string; fixed: Record<string, unknown> } {
  const [type, query] = arg.split("?");
  const fixed: Record<string, unknown> = {};
  for (const [key, raw] of new URLSearchParams(query ?? "")) {
    fixed[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return { type: type ?? arg, fixed };
}

function payloadOf(ctx: Context): Record<string, unknown> {
  const { locale: _locale, ...data } = ctx.payload;
  void _locale;
  return data;
}

function localeOf(ctx: Context, fixed: Record<string, unknown> = {}): { locale?: string; fallback?: boolean } {
  const locale = ctx.params.locale ?? first(ctx.payload.locale);
  const options: { locale?: string; fallback?: boolean } = {};
  if (locale !== undefined) options.locale = locale;
  if (fixed.fallback === true) options.fallback = true;
  return options;
}

interface ListOptions {
  limit?: number;
  offset?: number;
  sort?: Record<string, "asc" | "desc">;
}

function integerParam(ctx: Context, key: string): Result<number | undefined, KestrelError> {
  const raw = ctx.payload[key];
  if (raw === undefined || raw === "") return ok(undefined);
  const value = typeof raw === "number" ? raw : Number(first(raw) ?? NaN);
  if (!Number.isInteger(value)) return ctx.fail("VALIDATION", `content/default: ${key} must be an integer`);
  return ok(value);
}

function listOptions(ctx: Context, maxLimit: number): Result<ListOptions, KestrelError> {
  const options: ListOptions = {};
  const limit = integerParam(ctx, "limit");
  if (isErr(limit)) return limit;
  if (limit.value !== undefined) {
    if (limit.value < 1) return ctx.fail("VALIDATION", "content/default: limit must be at least 1");
    if (limit.value > maxLimit) return ctx.fail("VALIDATION", `content/default: limit must not exceed ${maxLimit}`);
    options.limit = limit.value;
  }
  const offset = integerParam(ctx, "offset");
  if (isErr(offset)) return offset;
  if (offset.value !== undefined) {
    if (offset.value < 0) return ctx.fail("VALIDATION", "content/default: offset must not be negative");
    options.offset = offset.value;
  }
  const sort = first(ctx.payload.sort);
  if (sort !== undefined && sort !== "") {
    const desc = sort.startsWith("-");
    options.sort = { [desc ? sort.slice(1) : sort]: desc ? "desc" : "asc" };
  }
  return ok(options);
}

function emptyDocument(model: ContentModel, type: string, fallback?: boolean): Record<string, unknown> {
  const doc: Record<string, unknown> = Object.fromEntries(Object.keys(model.types[type]?.fields ?? {}).map((f) => [f, null]));
  if (fallback) doc._locales = {};
  if (model.locales && model.locales.length > 0) doc._translations = Object.fromEntries(model.locales.map((l) => [l, false]));
  return doc;
}

function describeContent(content: ContentInstance) {
  const model = content.model();
  const docSchema = (type: string): JsonSchema => documentSchema(model, type);
  const writeSchema = (type: string, mode: "create" | "update"): JsonSchema => {
    const fields = model.types[type]?.fields ?? {};
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [name, raw] of Object.entries(fields)) {
      const def = typeof raw === "string" ? { type: raw } : raw;
      properties[name] = fieldSchema(raw, mode === "update" || !def.required);
      if (mode === "create" && def.required) required.push(name);
    }
    if (model.locales) properties.locale = { type: "string", enum: model.locales };
    const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
    if (required.length > 0) schema.required = required;
    return schema;
  };
  const localeQuery = (): Record<string, JsonSchema> => (model.locales ? { locale: { type: "string", enum: model.locales } } : {});
  const pageSchema = (type: string): JsonSchema => ({ type: "object", properties: { items: { type: "array", items: docSchema(type) }, total: { type: "number" } }, required: ["items", "total"] });
  const typeOf = (arg: string): string => parseTarget(arg).type;
  // A single type answers with an empty document instead of 404 — unless the step argument pins a
  // fixed filter the stored document can miss.
  const canMiss = (arg: string): boolean => {
    const { type, fixed } = parseTarget(arg);
    const { fallback: _fallback, ...filter } = fixed;
    void _fallback;
    return model.types[type]?.kind !== "single" || Object.keys(filter).length > 0;
  };
  const getErrors = (arg: string): Record<number, string> => {
    const errors: Record<number, string> = { 400: "unknown locale" };
    if (canMiss(arg)) errors[404] = "not found";
    return errors;
  };

  return {
    validate: (arg: string) => ({ summary: `Validate a ${typeOf(arg)} payload`, reads: [], writes: [], input: writeSchema(typeOf(arg), "create"), errors: { 400: "validation failed" } }),
    create: (arg: string) => ({ summary: `Create a ${typeOf(arg)}`, reads: [], writes: ["result"], input: writeSchema(typeOf(arg), "create"), output: docSchema(typeOf(arg)), errors: { 400: "validation failed", 409: "a document with that id already exists" } }),
    set: (arg: string) => ({ summary: `Replace the ${typeOf(arg)} document`, reads: [], writes: ["result"], input: writeSchema(typeOf(arg), "create"), output: docSchema(typeOf(arg)), errors: { 400: "validation failed" } }),
    get: (arg: string) => ({
      summary: `One ${typeOf(arg)} document`,
      reads: model.types[typeOf(arg)]?.kind === "single" ? [] : ["params.id"],
      writes: ["result"],
      query: localeQuery(),
      output: docSchema(typeOf(arg)),
      errors: getErrors(arg),
    }),
    list: (arg: string) => ({
      summary: `List ${typeOf(arg)}`,
      reads: [],
      writes: ["result"],
      query: { ...localeQuery(), limit: { type: "integer", minimum: 1, maximum: content.maxLimit }, offset: { type: "integer", minimum: 0 }, sort: { type: "string", description: "field name, prefix - for descending" } },
      output: pageSchema(typeOf(arg)),
      errors: { 400: "invalid limit, offset, sort or locale" },
    }),
    update: (arg: string) => ({ summary: `Update a ${typeOf(arg)}`, reads: ["params.id"], writes: ["result"], input: writeSchema(typeOf(arg), "update"), output: docSchema(typeOf(arg)), errors: { 400: "validation failed", 404: "not found" } }),
    remove: (arg: string) => ({ summary: `Delete a ${typeOf(arg)}`, reads: ["params.id"], writes: ["result"], output: { type: "object", properties: { ok: { type: "boolean" } } }, errors: { 400: "missing id" } }),
    removeTranslation: (arg: string) => ({
      summary: `Remove one translation of a ${typeOf(arg)} (locale from the route or ?locale=); the document stays in its other locales`,
      reads: ["params.id"],
      writes: ["result"],
      query: localeQuery(),
      output: docSchema(typeOf(arg)),
      errors: { 400: "unknown or missing locale", 404: "document or translation not found", 409: "last translation – remove the document" },
    }),
  };
}

export default defineModule({
  name: "content/default",
  provides: [CONTENT],
  requires: [PERSISTENCE],
  configSchema,

  async setup(config, deps): Promise<ContentInstance> {
    const model: ContentModel = { types: config.types as ContentModel["types"] };
    if (config.locales !== undefined) model.locales = config.locales;
    if (config.defaultLocale !== undefined) model.defaultLocale = config.defaultLocale;
    return { ...(await createContentDefault(model, deps.get(PERSISTENCE))), maxLimit: config.maxLimit };
  },

  steps: (content) => ({
    validate: stepFactory((type: string) => async (ctx: Context) => {
      const result = content.validate(type, payloadOf(ctx), "create", localeOf(ctx));
      if (!result.ok) return ctx.fail("VALIDATION", `${type}: ${result.errors.map((e) => `${e.field} ${e.message}`).join("; ")}`, { fields: result.errors });
      return ok(ctx);
    }),
    create: stepFactory((type: string) => async (ctx: Context) => {
      const created = await content.create(type, payloadOf(ctx), localeOf(ctx));
      if (isErr(created)) return ctx.fail(created.error);
      return ok({ ...ctx, result: created.value });
    }),
    set: stepFactory((type: string) => async (ctx: Context) => {
      const stored = await content.set(type, payloadOf(ctx), localeOf(ctx));
      if (isErr(stored)) return ctx.fail(stored.error);
      return ok({ ...ctx, result: stored.value });
    }),
    get: stepFactory((arg: string) => {
      const { type, fixed } = parseTarget(arg);
      const { fallback: _fallback, ...filter } = fixed;
      void _fallback;
      return async (ctx: Context) => {
        const notFound = () => ctx.fail("NOT_FOUND", `${type}${ctx.params.id ? `/${ctx.params.id}` : ""} not found`);
        const options = localeOf(ctx, fixed);
        const stored = await content.get(type, ctx.params.id, options);
        if (isErr(stored)) return ctx.fail(stored.error);
        const doc = stored.value ?? (content.model().types[type]?.kind === "single" ? emptyDocument(content.model(), type, options.fallback) : null);
        if (!doc) return notFound();
        for (const [key, value] of Object.entries(filter)) {
          if (doc[key] !== value) return notFound();
        }
        return ok({ ...ctx, result: doc });
      };
    }),
    list: stepFactory((arg: string) => {
      const { type, fixed } = parseTarget(arg);
      const { fallback: _fallback, ...filter } = fixed;
      void _fallback;
      return async (ctx: Context) => {
        const parsed = listOptions(ctx, content.maxLimit);
        if (isErr(parsed)) return parsed;
        const page = await content.list(type, filter, { ...parsed.value, ...localeOf(ctx, fixed) });
        if (isErr(page)) return ctx.fail(page.error);
        return ok({ ...ctx, result: page.value });
      };
    }),
    update: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const updated = await content.update(type, ctx.params.id, payloadOf(ctx), localeOf(ctx));
      if (isErr(updated)) return ctx.fail(updated.error);
      return ok({ ...ctx, result: updated.value });
    }),
    remove: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const removed = await content.remove(type, ctx.params.id);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: { ok: true } });
    }),
    removeTranslation: stepFactory((type: string) => async (ctx: Context) => {
      if (!ctx.params.id) return ctx.fail("VALIDATION", "missing id");
      const locale = localeOf(ctx).locale;
      if (locale === undefined) return ctx.fail("VALIDATION", "missing locale");
      const removed = await content.removeTranslation(type, ctx.params.id, locale);
      if (isErr(removed)) return ctx.fail(removed.error);
      return ok({ ...ctx, result: removed.value });
    }),
  }),

  describe: describeContent,
});
