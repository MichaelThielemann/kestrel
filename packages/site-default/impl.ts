import type { Content, ContentDocument, ContentError, ContentModel, LocaleOptions } from "@michaelthielemann/kestrel-contracts/content";
import { publishedLocale, satisfiesFilter } from "@michaelthielemann/kestrel-contracts/helpers/content-locale";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { LinkTarget } from "@michaelthielemann/kestrel-contracts/links";
import { INTERNAL_REF } from "@michaelthielemann/kestrel-contracts/links";
import { collectInternalRefs } from "@michaelthielemann/kestrel-contracts/helpers/links";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Site, SiteError, SiteRules } from "@michaelthielemann/kestrel-contracts/site";
import { noteRead, unobserved } from "@michaelthielemann/kestrel/reads";
import type { SitePaths } from "./paths.ts";

export { createSitePaths, type SitePaths, type SitePathsDeps } from "./paths.ts";
export { routesConfig, type Mounts, type Move, type Route, type RoutesConfig } from "./routes.ts";
import { splitTail, tailOf, withRouteConditions, type Route } from "./routes.ts";
import { pathOfTail, prefixSource } from "./table.ts";

interface Rules {
  home: string | null;
  slugField: string;
  prefixPrimary: boolean;
  fallback: boolean;
  filter: Filter;
}

function rulesOf(rules: SiteRules | undefined, type?: string, route?: Route): Rules {
  if (route) {
    if (rules?.slugField !== undefined && rules.slugField !== route.slugField) throw new Error(`site/default: "${type ?? ""}" is routed with slug field "${route.slugField}", but the call names "${rules.slugField}"`);
    if (rules?.home !== undefined && rules.home !== route.home) throw new Error(`site/default: "${type ?? ""}" is routed with home ${route.home === null ? "none" : `"${route.home}"`}, but the call names "${rules.home}"`);
  }
  return {
    home: route ? route.home : (rules?.home ?? "home"),
    slugField: rules?.slugField ?? route?.slugField ?? "slug",
    prefixPrimary: rules?.prefixPrimary ?? false,
    fallback: rules?.fallback ?? false,
    filter: rules?.filter ?? {},
  };
}

const DOCUMENT_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

function ownFields(definition: ContentModel["types"][string] | undefined, filter: Filter): Filter {
  const fields = definition?.fields ?? {};
  return Object.fromEntries(Object.entries(filter).filter(([name]) => DOCUMENT_FIELDS.has(name) || name in fields));
}

export function publicPath(slug: string, locale: string | undefined, defaultLocale: string | undefined, home: string | null, prefixPrimary: boolean): string {
  const prefixed = locale !== undefined && (prefixPrimary || locale !== defaultLocale);
  const segments = [...(prefixed ? [locale] : []), ...(slug === home ? [] : [slug])];
  return `/${segments.join("/")}`;
}

export function splitPath(path: string, locales: string[], prefixPrimary: boolean): { locale?: string; slug: string } | null {
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length > 2) return null;
  const [first, second] = segments;
  if (first !== undefined && locales.includes(first)) {
    return second === undefined ? { locale: first, slug: "" } : { locale: first, slug: second };
  }
  if (second !== undefined || (prefixPrimary && locales.length > 0)) return null;
  return { slug: first ?? "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rewrite(value: unknown, paths: Map<string, string | null>): unknown {
  if (typeof value === "string") {
    const exact = /^kestrel:([a-z][a-z0-9_]*):([A-Za-z0-9-]+)$/.exec(value);
    if (exact) return paths.get(`${exact[1]}:${exact[2]}`) ?? null;
    return value
      .replace(/href="kestrel:([a-z][a-z0-9_]*):([A-Za-z0-9-]+)"/g, (_m, t: string, id: string) => {
        const path = paths.get(`${t}:${id}`);
        return path ? `href="${path}"` : `href="#" data-kestrel-broken="${t}:${id}"`;
      })
      .replace(INTERNAL_REF, (_m, t: string, id: string) => paths.get(`${t}:${id}`) ?? "#");
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, paths));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewrite(v, paths);
    if (value.type === "internal" && typeof value.collection === "string" && typeof value.id === "string") {
      const path = paths.get(`${value.collection}:${value.id}`);
      if (path) out.path = path;
      else out.broken = true;
    }
    return out;
  }
  return value;
}

export interface SiteDefault extends Site {
  /** The model the paths are resolved against; the module describes its steps from it. */
  model(): ContentModel;
  /** The path index of the routed types; absent without `routes`. */
  readonly paths: SitePaths | undefined;
}

function isTransient(error: ContentError): error is SiteError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: ContentError): SiteError {
  if (!isTransient(error)) throw new Error(`site/default: unexpected content@1 error ${error.code}: ${error.message}`);
  return error;
}

function withPaths(doc: ContentDocument, paths: SitePaths | undefined, type: string): ContentDocument {
  return paths?.route(type) ? { ...doc, _paths: paths.pathsOf(type, doc.id, "reachable") } : doc;
}

export function createSiteDefault(content: Content, paths?: SitePaths): SiteDefault {
  const typeOf = (type: string): void => {
    if (!content.model().types[type]) throw new Error(`site/default: unknown type "${type}"`);
  };

  async function resolveUnrouted(type: string, path: string, rules: Rules): Promise<Result<ContentDocument | null, SiteError>> {
    const model = content.model();
    const parsed = splitPath(path, model.locales ?? [], rules.prefixPrimary);
    if (!parsed) return ok(null);
    const read: LocaleOptions = {};
    if (parsed.locale !== undefined) read.locale = parsed.locale;
    const slug = parsed.slug === "" ? (rules.home ?? "") : parsed.slug;
    const lookup = { ...rules.filter, [rules.slugField]: slug };
    const effective = parsed.locale ?? model.defaultLocale;
    const missed: Array<{ locale: string | undefined; filter: Filter }> = [];
    const answered = await unobserved(async (): Promise<Result<{ candidate: string | null; doc: ContentDocument | null }, SiteError>> => {
      const page = await content.list(type, lookup, { ...read, limit: 1 });
      if (isErr(page)) return err(transientOnly(page.error));
      const candidate: ContentDocument | undefined = page.value.items[0];
      if (!candidate) missed.push({ locale: effective, filter: lookup });
      if (!candidate) return ok({ candidate: null, doc: null });
      const viewResult = await publishedLocale(content, type, candidate.id, read.locale, rules.filter, { fallback: rules.fallback });
      if (isErr(viewResult)) return err(transientOnly(viewResult.error));
      return ok({ candidate: candidate.id, doc: viewResult.value });
    });
    if (isErr(answered)) return answered;
    for (const { locale, filter } of missed) noteRead({ kind: "query", type, filter, ...(locale === undefined ? {} : { locale }) });
    const { candidate, doc } = answered.value;
    if (candidate !== null) noteRead({ kind: "document", type, id: candidate, ...(effective === undefined ? {} : { locale: effective }) });
    if (!doc) return ok(null);
    return ok(effective === undefined ? doc : { ...doc, _locale: effective });
  }

  async function resolveRouted(table: SitePaths, type: string, path: string, rules: Rules, route: Route): Promise<Result<ContentDocument | null, SiteError>> {
    const model = content.model();
    const split = splitTail(path, model.locales ?? [], model.defaultLocale ?? "", rules.prefixPrimary);
    if (!split) return ok(null);
    const readLocale = split.explicit ? split.locale : undefined;
    const effective = split.locale === "" ? undefined : split.locale;
    const claim = table.table.claim(split.locale, split.tail);
    const filter = withRouteConditions(route, rules.filter);
    const gated = Object.keys(rules.filter).length > 0;
    const answered = await unobserved(async (): Promise<Result<{ candidate: string | null; doc: ContentDocument | null }, SiteError>> => {
      let holder = claim.strong?.valid === true && (claim.strong.live || !gated) ? claim.strong : undefined;
      if (holder) {
        const passes = await satisfiesFilter(content, holder.type, holder.docId, readLocale, filter);
        if (isErr(passes)) return err(transientOnly(passes.error));
        if (!passes.value) holder = undefined;
      }
      if (!holder || holder.type !== type) return ok({ candidate: null, doc: null });
      const viewResult = await publishedLocale(content, type, holder.docId, readLocale, filter, { fallback: rules.fallback });
      if (isErr(viewResult)) return err(transientOnly(viewResult.error));
      return ok({ candidate: holder.docId, doc: viewResult.value });
    });
    if (isErr(answered)) return answered;
    const { candidate, doc } = answered.value;
    const segments = split.tail.split("/");
    const slug = split.tail === "" ? (rules.home ?? "") : (segments[segments.length - 1] ?? "");
    if (candidate === null) noteRead({ kind: "query", type, filter: { ...filter, [rules.slugField]: slug }, ...(effective === undefined ? {} : { locale: effective }) });
    else noteRead({ kind: "document", type, id: candidate, ...(effective === undefined ? {} : { locale: effective }) });
    if (!doc) return ok(null);
    return ok(withPaths(effective === undefined ? doc : { ...doc, _locale: effective }, table, type));
  }

  function pathOfRouted(table: SitePaths, type: string, document: ContentDocument, locale: string, rules: Rules, route: Route): string | null {
    const slug = document[rules.slugField];
    if (typeof slug !== "string" || slug === "") return null;
    if (table.table.rowsOf(type, document.id).length > 0) {
      const row = table.table.row(type, document.id, locale);
      if (!row || row.tail === null || !row.valid) return null;
      const last = row.tail === "" ? route.home : (row.tail.split("/").pop() ?? "");
      if (last !== slug) return null;
      if (Object.keys(rules.filter).length > 0 && !row.live) return null;
      return pathOfTail(table.format, row.tail, locale, rules.prefixPrimary);
    }
    const parent = route.parentField === null ? null : document[route.parentField];
    const source = prefixSource(table.format, { type, parent: typeof parent === "string" && parent !== "" ? parent : null }, table.table.mounts);
    let tail: string;
    if (source === undefined) tail = tailOf(slug, route);
    else {
      const at = source.indexOf("/");
      const prefix = table.table.row(source.slice(0, at), source.slice(at + 1), locale)?.tail;
      if (prefix === undefined || prefix === null) return null;
      tail = prefix === "" ? slug : `${prefix}/${slug}`;
    }
    const claim = table.table.claim(locale, tail);
    if (claim.strong || claim.weak.length > 0) return null;
    return pathOfTail(table.format, tail, locale, rules.prefixPrimary);
  }

  async function linkedPathRouted(table: SitePaths, route: Route, t: string, id: string, locale: string, rules: Rules): Promise<Result<string | null, SiteError>> {
    const row = table.table.row(t, id, locale);
    if (!row || row.tail === null || !row.valid) return ok(null);
    if (Object.keys(rules.filter).length === 0) return ok(pathOfTail(table.format, row.tail, locale, rules.prefixPrimary));
    if (!row.live) return ok(null);
    const passes = await unobserved(() => satisfiesFilter(content, t, id, locale === "" ? undefined : locale, ownFields(content.model().types[t], withRouteConditions(route, rules.filter))));
    if (isErr(passes)) return err(transientOnly(passes.error));
    return ok(passes.value ? pathOfTail(table.format, row.tail, locale, rules.prefixPrimary) : null);
  }

  return {
    model: () => content.model(),
    paths,

    async resolve(type, path, options = {}): Promise<Result<ContentDocument | null, SiteError>> {
      typeOf(type);
      const route = paths?.route(type);
      const rules = rulesOf(options.rules, type, route);
      return paths && route ? resolveRouted(paths, type, path, rules, route) : resolveUnrouted(type, path, rules);
    },

    pathOf(type, document, options = {}) {
      typeOf(type);
      const route = paths?.route(type);
      const rules = rulesOf(options.rules, type, route);
      const model = content.model();
      const locale = options.locale ?? document._locale ?? model.defaultLocale;
      if (paths && route) return pathOfRouted(paths, type, document, locale ?? "", rules, route);
      if (locale !== undefined && typeof document._locale === "string" && document._locale !== locale) return null;
      const origin = isRecord(document._locales) ? document._locales[rules.slugField] : undefined;
      if (locale !== undefined && typeof origin === "string" && origin !== locale) return null;
      const slug = document[rules.slugField];
      if (typeof slug !== "string" || slug === "") return null;
      return publicPath(slug, locale, model.defaultLocale, rules.home, rules.prefixPrimary);
    },

    async resolveLinks(type, document, options = {}): Promise<Result<ContentDocument, SiteError>> {
      typeOf(type);
      const rules = rulesOf(options.rules);
      const model = content.model();
      const locale = options.locale ?? document._locale ?? model.defaultLocale;
      const refs = new Set<string>();
      for (const [k, v] of Object.entries(document)) if (!k.startsWith("_") && k !== "id") for (const r of collectInternalRefs(v)) refs.add(`${r.type}:${r.id}`);
      if (refs.size === 0) return ok(document);
      const paths_ = new Map<string, string | null>();
      const links: Record<string, LinkTarget> = {};
      for (const ref of refs) {
        const at = ref.indexOf(":");
        const t = ref.slice(0, at);
        const id = ref.slice(at + 1);
        let path: string | null = null;
        if (model.types[t]) {
          const route = paths?.route(t);
          if (paths && route) {
            const linked = await linkedPathRouted(paths, route, t, id, locale ?? "", rules);
            if (isErr(linked)) return linked;
            path = linked.value;
          } else {
            const viewResult = await unobserved(() => publishedLocale(content, t, id, locale, ownFields(model.types[t], rules.filter), { fallback: false, translations: false }));
            if (isErr(viewResult)) return err(transientOnly(viewResult.error));
            const slug = viewResult.value?.[rules.slugField];
            if (typeof slug === "string" && slug !== "") path = publicPath(slug, locale, model.defaultLocale, rules.home, rules.prefixPrimary);
          }
          noteRead({ kind: "path", type: t, id, locale: locale ?? "", rules: { ...rules }, path });
        }
        paths_.set(ref, path);
        links[id] = path ? { path, locale: locale ?? "" } : { broken: true };
      }
      const out: ContentDocument = { ...document };
      for (const [k, v] of Object.entries(document)) if (!k.startsWith("_") && k !== "id") out[k] = rewrite(v, paths_);
      out._links = links;
      return ok(out);
    },
  };
}
