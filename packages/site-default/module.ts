import { z } from "zod";
import { CONTENT, type ContentDocument } from "@michaelthielemann/kestrel-contracts/content";
import { documentSchema } from "@michaelthielemann/kestrel-contracts/content-schema";
import { SITE, type SiteRules } from "@michaelthielemann/kestrel-contracts/site";
import { first, stepFactory, type Context } from "@michaelthielemann/kestrel/context";
import { defineModule } from "@michaelthielemann/kestrel/defineModule";
import { isErr, ok } from "@michaelthielemann/kestrel/result";
import { createSiteDefault, type SiteDefault } from "./impl.ts";

export const configSchema = z.object({}).strict();

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
  return {
    home: typeof fixed.home === "string" ? fixed.home : "home",
    slugField: typeof fixed.slugField === "string" ? fixed.slugField : "slug",
    fallback: fixed.fallback === true,
    prefixPrimary: fixed.prefixPrimary === true,
    filter: Object.fromEntries(Object.entries(fixed).filter(([k]) => !RULE_KEYS.has(k))),
  };
}

function describeSite(site: SiteDefault) {
  const model = site.model();
  const typeOf = (arg: string): string => arg.split("?")[0] ?? arg;

  return {
    resolve: (arg: string) => ({
      summary: `Resolve a site path to a ${typeOf(arg)} document${arg.includes("prefixPrimary=true") ? " (every locale prefixed)" : " (default locale unprefixed)"}`,
      reads: ["params.path"],
      writes: ["result"],
      output: documentSchema(model, typeOf(arg), { siteFields: true }),
      errors: { 404: "no page at this path" },
    }),
    resolveLinks: (arg: string) => ({
      summary: `Replace internal kestrel:<type>:<id> references in the ${typeOf(arg)} document with public paths (_links map added)`,
      reads: ["result"],
      writes: ["result"],
    }),
  };
}

export default defineModule({
  name: "site/default",
  provides: [SITE],
  requires: [CONTENT],
  configSchema,

  async setup(config, deps): Promise<SiteDefault> {
    return createSiteDefault(deps.get(CONTENT));
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
        const doc = ctx.result as ContentDocument | undefined;
        if (!doc || typeof doc !== "object") throw new Error(`site/default: resolveLinks step ran without a document in result`);
        const locale = doc._locale ?? ctx.params.locale ?? first(ctx.payload.locale);
        const resolved = await site.resolveLinks(type, doc, { ...(locale === undefined ? {} : { locale }), rules });
        if (isErr(resolved)) return ctx.fail(resolved.error);
        return ok({ ...ctx, result: resolved.value });
      };
    }),
  }),

  describe: describeSite,
});
