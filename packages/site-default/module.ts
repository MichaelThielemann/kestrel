import { z } from "zod";
import { CONTENT, type ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { documentSchema } from "@michaelthielemann/kestrel-contracts/content-schema";
import { EVENTS } from "@michaelthielemann/kestrel-contracts/events";
import { PERSISTENCE } from "@michaelthielemann/kestrel-contracts/persistence";
import { ownedPersistence } from "@michaelthielemann/kestrel-contracts/persistence.owned";
import { SITE, type SiteRules } from "@michaelthielemann/kestrel-contracts/site";
import { boundaryCast } from "@michaelthielemann/kestrel/cast";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createSiteDefault, type SiteDefault } from "./impl.ts";
import { createSitePaths, type RebuildPlan, type SitePaths } from "./paths.ts";
import { PATHS_MOVED, type RoutesConfig } from "./routes.ts";
import { COLLECTIONS } from "./table.ts";
import { checkPathWiring, checkRoutedModel } from "./wiring.ts";

const routeSchema = z
  .object({
    slugField: z.string().min(1).default("slug"),
    home: z.string().min(1).optional(),
    liveWhen: z.record(z.unknown()).default({}),
    labelField: z.string().min(1).default("title"),
  })
  .strict();

export const configSchema = z
  .object({
    routes: z.record(routeSchema).default({}),
    prefixPrimary: z.boolean().default(false),
    reservedPaths: z.array(z.string().regex(/^(\/[A-Za-z0-9._-]+)+$/)).default([]),
  })
  .strict();

function parseTarget(arg: string): { type: string; fixed: Record<string, unknown> } {
  const [type, query] = arg.split("?");
  const fixed: Record<string, unknown> = {};
  for (const [key, raw] of new URLSearchParams(query ?? "")) {
    fixed[key] = raw === "true" ? true : raw === "false" ? false : raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return { type: type ?? arg, fixed };
}

const RULE_KEYS = new Set(["home", "slugField", "fallback", "prefixPrimary"]);

function siteRules(fixed: Record<string, unknown>): SiteRules {
  const rules: SiteRules = {
    fallback: fixed.fallback === true,
    prefixPrimary: fixed.prefixPrimary === true,
    filter: Object.fromEntries(Object.entries(fixed).filter(([k]) => !RULE_KEYS.has(k))),
  };
  if (typeof fixed.home === "string") rules.home = fixed.home;
  if (typeof fixed.slugField === "string") rules.slugField = fixed.slugField;
  return rules;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routedPaths(site: SiteDefault, step: string, type?: string): SitePaths {
  const paths = site.paths;
  if (!paths) throw new Error(`site/default: ${step} needs "routes" in the site/default config`);
  if (type !== undefined && !paths.route(type)) throw new Error(`site/default: ${step}:${type} needs "${type}" in routes`);
  return paths;
}

const PATHS_SCHEMA = { type: "object", additionalProperties: { type: ["string", "null"] }, description: "public path per locale; null where the document is not reachable (site.attachPaths without ?reachable: not valid)" };
const MOVES_SUMMARY = "patches the in-memory path table from the committed rows and raises site.pathsMoved";
const CONFLICT_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, locale: { type: "string" }, type: { type: "string" }, id: { type: "string" }, label: { type: "string" } },
  required: ["path", "locale", "type", "id", "label"],
};

function describeSite(site: SiteDefault) {
  const model = site.model();
  const typeOf = (arg: string): string => arg.split("?")[0] ?? arg;
  const routed = (arg: string): boolean => site.paths?.route(typeOf(arg)) !== undefined;

  return {
    resolve: (arg: string) => {
      const output = documentSchema(model, typeOf(arg), { siteFields: true });
      const properties = isRecord(output.properties) ? output.properties : {};
      return {
        summary: `Resolve a site path to a ${typeOf(arg)} document${arg.includes("prefixPrimary=true") ? " (every locale prefixed)" : " (default locale unprefixed)"}`,
        reads: ["params.path"],
        writes: ["result"],
        output: routed(arg) ? { ...output, properties: { ...properties, _paths: PATHS_SCHEMA } } : output,
        errors: { 404: "no page at this path" },
      };
    },
    resolveLinks: (arg: string) => ({
      summary: `Replace internal kestrel:<type>:<id> references in the ${typeOf(arg)} document with public paths (_links map added)`,
      reads: ["result"],
      writes: ["result"],
      query: { locale: { type: "string" } },
      extendsOutput: {
        type: "object",
        properties: { _links: { type: "object", additionalProperties: { type: "object", properties: { path: { type: "string" }, locale: { type: "string" }, broken: { type: "boolean" } }, required: [] }, description: "internal references by target id after site.resolveLinks; absent when the document has no internal references to resolve" } },
        required: [],
      },
    }),
    indexPath: (arg: string) => ({
      summary: `Recompute the public paths of the saved ${arg} (result.id, else params.id) and of every document whose path depends on it; last step of the write's atomic group`,
      reads: ["result.id?", "params.id?"],
      writes: [],
      errors: { 400: "the path is reserved or starts with a locale code", 409: "another document holds the path", 503: "the store is unavailable" },
      atomicSafe: true,
    }),
    announcePaths: { summary: `After the write's atomic group: ${MOVES_SUMMARY}; never fails the run`, reads: [], writes: [] },
    resumePaths: {
      summary: `Announce path changes a run left unannounced (${MOVES_SUMMARY}) and prune announced ones older than 7 days`,
      reads: [],
      writes: ["result"],
      output: { type: "object", properties: { announced: { type: "integer" }, pruned: { type: "integer" } }, required: ["announced", "pruned"] },
      errors: { 503: "the store is unavailable" },
    },
    planRebuild: {
      summary: "Recompute every routed document's paths from content@1 outside any group (adds `rebuild` to the result)",
      reads: [],
      writes: ["result.rebuild"],
      extendsOutput: { type: "object", properties: { rebuild: { type: "object" } }, required: ["rebuild"] },
      errors: { 503: "the store is unavailable" },
    },
    applyRebuild: {
      summary: "Write the planned paths inside one atomic group; saves committed since the plan are recomputed there",
      reads: ["result.rebuild"],
      writes: ["result"],
      output: {
        type: "object",
        properties: {
          indexed: { type: "integer" },
          conflicts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, locale: { type: "string" }, winner: { type: ["object", "null"] }, losers: { type: "array", items: { type: "object" } }, reason: { type: "string", enum: ["taken", "reserved", "locale"] } }, required: ["path", "locale", "winner", "losers", "reason"] } },
        },
        required: ["indexed", "conflicts"],
      },
      errors: { 503: "the store is unavailable" },
      atomicSafe: true,
    },
    previewPath: (arg: string) => ({
      summary: `The public path a ${arg} would get for payload { id?, locale?, slug }, whether it would be reachable and why not; writes nothing`,
      reads: [],
      writes: ["result"],
      input: { type: "object", properties: { id: { type: "string" }, locale: { type: "string" }, slug: { type: "string", minLength: 1 } }, required: ["slug"], additionalProperties: true },
      output: {
        type: "object",
        properties: {
          path: { type: "string" },
          reachable: { type: "boolean" },
          reason: { type: ["string", "null"] },
          conflict: { anyOf: [CONFLICT_SCHEMA, { type: "null" }] },
          shadows: { type: "array", items: { type: "object", properties: { type: { type: "string" }, id: { type: "string" }, label: { type: "string" }, path: { type: "string" } }, required: ["type", "id", "label", "path"] } },
          exposesParentSlug: { type: "null" },
        },
        required: ["path", "reachable", "reason", "conflict", "shadows", "exposesParentSlug"],
      },
      errors: { 400: "slug is missing", 503: "the store is unavailable" },
    }),
    attachPaths: (arg: string) => ({
      summary: `Add _paths (locale → path) to the ${typeOf(arg)} result${arg.includes("reachable") ? ", reachable paths only" : ", every valid path including drafts"}`,
      reads: ["result"],
      writes: ["result"],
      extendsItems: { type: "object", properties: { _paths: PATHS_SCHEMA }, required: ["_paths"] },
    }),
  };
}

export default defineModule({
  name: "site/default",
  provides: [SITE],
  requires: [CONTENT],
  optional: [PERSISTENCE, EVENTS],
  emits: [PATHS_MOVED],
  configSchema,

  async setup(config, deps): Promise<SiteDefault> {
    const content = deps.get(CONTENT);
    if (Object.keys(config.routes).length === 0) return createSiteDefault(content);
    const db = deps.find(PERSISTENCE);
    const events = deps.find(EVENTS);
    if (!db) throw new Error("site/default: routes need a persistence@1 provider to store the path index");
    if (!events) throw new Error("site/default: routes need an events@1 provider to raise site.pathsMoved");
    const routes: RoutesConfig = {
      routes: Object.fromEntries(Object.entries(config.routes).map(([type, r]) => [type, { slugField: r.slugField, home: r.home ?? null, liveWhen: r.liveWhen, labelField: r.labelField }])),
      prefixPrimary: config.prefixPrimary,
      reservedPaths: config.reservedPaths,
    };
    checkRoutedModel(routes.routes, content.model(), deps.logger);
    const paths = await createSitePaths(routes, { content, db: ownedPersistence(db, "site/default", COLLECTIONS), events, logger: deps.logger, ...(deps.bootStartedAt === undefined ? {} : { bootedAt: deps.bootStartedAt }) });
    return createSiteDefault(content, paths);
  },

  attach: (site, kestrel) => {
    if (site.paths) checkPathWiring(kestrel.describe(), site.paths.config.routes);
  },

  steps: (site) => ({
    resolve: stepFactory((arg: string) => {
      const { type, fixed } = parseTarget(arg);
      const rules = siteRules(fixed);
      return async (ctx: Context) => {
        const path = ctx.params.path ?? "";
        const doc = await site.resolve(type, path, { rules });
        if (isErr(doc)) return ctx.fail(doc.error);
        if (!doc.value) return ctx.fail("NOT_FOUND", `no page at /${path}`);
        return ok({ ...ctx, result: doc.value });
      };
    }),
    resolveLinks: stepFactory((arg: string) => {
      const { type, fixed } = parseTarget(arg);
      const rules = siteRules(fixed);
      return async (ctx: Context) => {
        if (!ctx.result || typeof ctx.result !== "object") throw new Error(`site/default: resolveLinks step ran without a document in result`);
        const doc = boundaryCast<ContentDocument>(ctx.result, "json");
        const locale = doc._locale ?? ctx.params.locale ?? first(ctx.payload.locale);
        const resolved = await site.resolveLinks(type, doc, { ...(locale === undefined ? {} : { locale }), rules });
        if (isErr(resolved)) return ctx.fail(resolved.error);
        return ok({ ...ctx, result: resolved.value });
      };
    }),
    indexPath: stepFactory((type: string) => {
      const paths = routedPaths(site, "site.indexPath", type);
      return async (ctx: Context) => {
        const result = isRecord(ctx.result) ? ctx.result : {};
        const id = typeof result.id === "string" ? result.id : ctx.params.id;
        if (id === undefined || id === "") throw new Error(`site/default: site.indexPath:${type} found no document id in result.id or params.id`);
        const indexed = await paths.index(type, id, ctx.runId);
        if (isErr(indexed)) return ctx.fail(indexed.error);
        return ok(ctx);
      };
    }),
    announcePaths: async (ctx: Context) => {
      await routedPaths(site, "site.announcePaths").announce(ctx.runId);
      return ok(ctx);
    },
    resumePaths: async (ctx: Context) => {
      const resumed = await routedPaths(site, "site.resumePaths").resume();
      if (isErr(resumed)) return ctx.fail(resumed.error);
      return ok({ ...ctx, result: resumed.value });
    },
    planRebuild: async (ctx: Context) => {
      const planned = await routedPaths(site, "site.planRebuild").planRebuild();
      if (isErr(planned)) return ctx.fail(planned.error);
      return ok({ ...ctx, result: { ...(isRecord(ctx.result) ? ctx.result : {}), rebuild: planned.value } });
    },
    applyRebuild: async (ctx: Context) => {
      const plan = isRecord(ctx.result) ? ctx.result.rebuild : undefined;
      if (!isRecord(plan)) throw new Error("site/default: site.applyRebuild ran without a plan from site.planRebuild in result.rebuild");
      const applied = await routedPaths(site, "site.applyRebuild").applyRebuild(boundaryCast<RebuildPlan>(plan, "host"), ctx.runId);
      if (isErr(applied)) return ctx.fail(applied.error);
      return ok({ ...ctx, result: applied.value });
    },
    previewPath: stepFactory((type: string) => {
      const paths = routedPaths(site, "site.previewPath", type);
      return async (ctx: Context) => {
        const slug = first(ctx.payload.slug);
        if (typeof slug !== "string" || slug === "") return ctx.fail("VALIDATION", "site.previewPath: slug is missing");
        const id = first(ctx.payload.id);
        const locale = first(ctx.payload.locale);
        const preview = await paths.preview(type, { slug, ...(typeof id === "string" && id !== "" ? { id } : {}), ...(typeof locale === "string" && locale !== "" ? { locale } : {}) });
        if (isErr(preview)) return ctx.fail(preview.error);
        return ok({ ...ctx, result: preview.value });
      };
    }),
    attachPaths: stepFactory((arg: string) => {
      const { type, fixed } = parseTarget(arg);
      const paths = routedPaths(site, "site.attachPaths", type);
      const mode = fixed.reachable === true || fixed.reachable === "" ? "reachable" : "valid";
      const withPaths = (item: unknown): unknown => (isRecord(item) && typeof item.id === "string" ? { ...item, _paths: paths.pathsOf(type, item.id, mode) } : item);
      return async (ctx: Context) => {
        const result = ctx.result;
        if (isRecord(result) && Array.isArray(result.items)) return ok({ ...ctx, result: { ...result, items: result.items.map(withPaths) } });
        return ok({ ...ctx, result: withPaths(result) });
      };
    }),
  }),

  describe: describeSite,
});
