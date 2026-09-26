import { removeContentFieldProperty } from "./edits.ts";
import { isRecord } from "./guards.ts";
import type { Rule, RuleContext } from "./plugin.ts";
import type { Finding } from "./report.ts";
import { finding, infoFinding, moduleEntry, upgradingDocs } from "./ruleHelpers.ts";

interface RouteEntry {
  type: string;
  slugField: string;
  nested: boolean;
}

function routesOf(ctx: RuleContext): RouteEntry[] {
  const config = moduleEntry(ctx, "site-default")?.config;
  const routes = isRecord(config) && isRecord(config.routes) ? config.routes : {};
  return Object.entries(routes).map(([type, raw]) => {
    const route = isRecord(raw) ? raw : {};
    return { type, slugField: typeof route.slugField === "string" ? route.slugField : "slug", nested: typeof route.parentField === "string" || route.mount === true };
  });
}

function providesContract(ctx: RuleContext, contract: string): boolean {
  return ctx.project.input.modules.some((m) => m.provides.some((c) => c.name === contract));
}

/** `site/routed-slug-unique`: a slug field of a type in `site-default`'s `routes` marked `unique`; the path, not the slug, is unique. */
export const routedSlugUniqueRule: Rule = {
  id: "site/routed-slug-unique",
  check(ctx) {
    const content = moduleEntry(ctx, "content-default");
    const types = isRecord(content?.config) && isRecord(content.config.types) ? content.config.types : {};
    const findings: Finding[] = [];
    for (const route of routesOf(ctx)) {
      const type = types[route.type];
      const fields = isRecord(type) && isRecord(type.fields) ? type.fields : {};
      const field = fields[route.slugField];
      if (!isRecord(field) || field.unique !== true || content === undefined) continue;
      const model = ctx.project.contentModel;
      const file = model?.file ?? ctx.project.configFile;
      const source = ctx.readFile(file);
      const edit = source === undefined ? undefined : removeContentFieldProperty(file, source, { use: model?.use ?? content.use, typeName: route.type, field: route.slugField, key: "unique", ...(ctx.locateModelFields === undefined ? {} : { locateModelFields: ctx.locateModelFields }) });
      const message = `${route.type}.${route.slugField} is unique, but ${route.type} is routed: its public path is unique instead, and a unique slug rejects the same slug in two places without naming the occupant${route.nested ? "; with a parent field or a mount, setup fails" : ""}`;
      const suggestion = `remove unique: true from ${route.type}.${route.slugField}; the index drops at the next boot`;
      findings.push(finding(`site/routed-slug-unique:${route.type}`, "site/routed-slug-unique", message, edit === undefined ? `${suggestion} (by hand: the field's definition is not an object literal in ${file})` : suggestion, { file, module: "site/default", path: `types.${route.type}.fields.${route.slugField}` }, edit === undefined ? undefined : [edit], upgradingDocs("site-routed-slug-unique"), route.nested ? "error" : "warning"));
    }
    return findings;
  },
};

/** `site/path-wiring`: `site-default`'s attach check failed: a routed write without the index steps, or a read with another `home` or `slugField`. */
export const pathWiringRule: Rule = {
  id: "site/path-wiring",
  check(ctx) {
    return ctx.bootCheck.errors
      .filter((e) => e.module === "site/default" && (e.code === "attach-failed" || e.code === "setup-failed") && /site\.indexPath|site\.indexMounts|site\.announcePaths|names (home|slugField)/.test(e.reason))
      .map((e, i) =>
        finding(
          `site/path-wiring:${i}`,
          "site/path-wiring",
          e.reason,
          "end every atomic group writing a routed type with site.indexPath:<type> (a mounts write with site.indexMounts), follow it with site.announcePaths, and drop home/slugField arguments that differ from the route",
          { module: "site/default" },
          undefined,
          upgradingDocs("site-path-wiring"),
        ),
      );
  },
};

/** `site/path-events`: routes configured without an `events@1` provider, or without a pipeline on `site.pathsMoved`. */
export const pathEventsRule: Rule = {
  id: "site/path-events",
  check(ctx) {
    if (routesOf(ctx).length === 0) return [];
    const where = { file: ctx.project.configFile, module: "site/default" };
    if (!providesContract(ctx, "events@1")) {
      return [finding("site/path-events:events", "site/path-events", "site-default's routes need an events@1 provider to raise site.pathsMoved; setup fails without one", "add @michaelthielemann/kestrel-events-inmemory with events-direct or events-queue", where, undefined, upgradingDocs("site-path-events"))];
    }
    const subscribed = ctx.project.input.config.triggers.some((t) => "event" in t && t.event === "site.pathsMoved");
    if (subscribed) return [];
    return [finding("site/path-events:consumer", "site/path-events", "site-default's routes raise site.pathsMoved, but no pipeline runs on it: renamed pages leave no redirect behind and moved static outputs are not re-rendered", 'add triggers on "site.pathsMoved" for pipelines running redirects.recordMoves then redirects.export, and delivery.markMoved', where, undefined, upgradingDocs("site-path-events"), "warning")];
  },
};

/** `redirects/requires-persistence`: `redirects-default` requires `persistence@1` in 6.0.0. */
export const redirectsPersistenceRule: Rule = {
  id: "redirects/requires-persistence",
  check(ctx) {
    const redirects = moduleEntry(ctx, "redirects-default");
    if (redirects === undefined || providesContract(ctx, "persistence@1")) return [];
    return [finding("redirects/requires-persistence", "redirects/requires-persistence", "redirects-default requires a persistence@1 provider in 6.0.0 for its automatic redirects; boot fails without one", "configure a persistence module such as @michaelthielemann/kestrel-persistence-sqlite", { file: ctx.project.configFile, module: "redirects/default" }, undefined, upgradingDocs("redirects-requires-persistence"))];
  },
};

const REDIRECTS_IMPL = /from\s*["'][^"']*kestrel-redirects-default\/impl["']/;

/** `imports/redirects-impl`: code calling `createRedirects` directly; it is async and takes `db`, and `validate` answers a `Promise<Result>`. */
export const redirectsImplRule: Rule = {
  id: "imports/redirects-impl",
  check(ctx) {
    const findings: Finding[] = [];
    for (const [moduleName, file] of ctx.project.moduleFiles) {
      const source = ctx.readFile(file);
      if (source === undefined || !REDIRECTS_IMPL.test(source)) continue;
      findings.push(infoFinding(`imports/redirects-impl:${moduleName}`, "imports/redirects-impl", `module "${moduleName}" imports kestrel-redirects-default/impl: createRedirects is async and needs a db (persistence@1) in its deps, and Redirects.validate returns a Promise<Result>`, "await createRedirects(config, { content, blobs, db, logger }) and await validate(), handling its Err", { file, module: moduleName }, upgradingDocs("imports-redirects-impl")));
    }
    return findings;
  },
};

export const SITE_PATH_RULES: readonly Rule[] = [routedSlugUniqueRule, pathWiringRule, pathEventsRule, redirectsPersistenceRule, redirectsImplRule];
