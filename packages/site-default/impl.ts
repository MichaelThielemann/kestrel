import type { Content, ContentDocument, ContentError, ContentModel, LocaleOptions } from "@michaelthielemann/kestrel-contracts/content";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { LinkTarget } from "@michaelthielemann/kestrel-contracts/links";
import { INTERNAL_REF, collectInternalRefs } from "@michaelthielemann/kestrel-contracts/links";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Site, SiteError, SiteRules } from "@michaelthielemann/kestrel-contracts/site";

interface Rules {
  home: string;
  slugField: string;
  prefixPrimary: boolean;
  fallback: boolean;
  filter: Filter;
}

function rulesOf(rules: SiteRules | undefined): Rules {
  return {
    home: rules?.home ?? "home",
    slugField: rules?.slugField ?? "slug",
    prefixPrimary: rules?.prefixPrimary ?? false,
    fallback: rules?.fallback ?? false,
    filter: rules?.filter ?? {},
  };
}

export function publicPath(slug: string, locale: string | undefined, defaultLocale: string | undefined, home: string, prefixPrimary: boolean): string {
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
  if (typeof value === "object" && value !== null) {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = rewrite(v, paths);
    if (o.type === "internal" && typeof o.collection === "string" && typeof o.id === "string") {
      const path = paths.get(`${o.collection}:${o.id}`);
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
}

/** Every locale site/default passes to content@1 comes from the model's own locale list, so a VALIDATION or NOT_FOUND there is a bug, not a site@1 failure. */
function transientOnly(error: ContentError): SiteError {
  if (error.code !== "TRANSIENT") throw new Error(`site/default: unexpected content@1 error ${error.code}: ${error.message}`);
  return error as SiteError;
}

export function createSiteDefault(content: Content): SiteDefault {
  const typeOf = (type: string): void => {
    if (!content.model().types[type]) throw new Error(`site/default: unknown type "${type}"`);
  };

  return {
    model: () => content.model(),

    async resolve(type, path, options = {}): Promise<Result<ContentDocument | null, SiteError>> {
      typeOf(type);
      const rules = rulesOf(options.rules);
      const model = content.model();
      const parsed = splitPath(path, model.locales ?? [], rules.prefixPrimary);
      if (!parsed) return ok(null);
      const read: LocaleOptions = {};
      if (parsed.locale !== undefined) read.locale = parsed.locale;
      if (rules.fallback) read.fallback = true;
      const slug = parsed.slug === "" ? rules.home : parsed.slug;
      const page = await content.list(type, { ...rules.filter, [rules.slugField]: slug }, { ...read, limit: 1 });
      if (isErr(page)) return err(transientOnly(page.error));
      let doc: ContentDocument | undefined = page.value.items[0];
      if (!doc && read.fallback && read.locale !== undefined && read.locale !== model.defaultLocale) {
        const fields = model.types[type]?.fields ?? {};
        const isLocalized = (field: string): boolean => {
          const raw = fields[field];
          return raw !== undefined && typeof raw !== "string" && raw.localized === true;
        };
        // The slug may only exist in the default locale, so the lookup drops the localized filters and
        // re-checks them strictly afterwards: a locale that is not published itself must stay unserved.
        const shared = Object.fromEntries(Object.entries(rules.filter).filter(([f]) => !isLocalized(f)));
        const viaDefaultPage = await content.list(type, { ...shared, [rules.slugField]: slug }, { limit: 1 });
        if (isErr(viaDefaultPage)) return err(transientOnly(viaDefaultPage.error));
        const viaDefault = viaDefaultPage.value.items[0];
        if (viaDefault) {
          const strictResult = await content.get(type, viaDefault.id, { locale: read.locale });
          if (isErr(strictResult)) return err(transientOnly(strictResult.error));
          const strict = strictResult.value;
          const localizedFiltersHold = Object.entries(rules.filter)
            .filter(([f]) => isLocalized(f))
            .every(([f, v]) => strict?.[f] === v);
          if (localizedFiltersHold) {
            const finalResult = await content.get(type, viaDefault.id, read);
            if (isErr(finalResult)) return err(transientOnly(finalResult.error));
            doc = finalResult.value ?? undefined;
          }
        }
      }
      if (!doc) return ok(null);
      const effective = parsed.locale ?? model.defaultLocale;
      return ok(effective === undefined ? doc : { ...doc, _locale: effective });
    },

    pathOf(type, document, options = {}) {
      typeOf(type);
      const rules = rulesOf(options.rules);
      const model = content.model();
      const locale = options.locale ?? document._locale ?? model.defaultLocale;
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
      const paths = new Map<string, string | null>();
      const links: Record<string, LinkTarget> = {};
      for (const ref of refs) {
        const [t, id] = ref.split(":") as [string, string];
        let path: string | null = null;
        if (model.types[t]) {
          const strictResult = await content.get(t, id, locale === undefined ? {} : { locale });
          if (isErr(strictResult)) return err(transientOnly(strictResult.error));
          const strict = strictResult.value;
          if (strict && Object.entries(rules.filter).every(([f, v]) => strict[f] === v)) {
            let slug = strict[rules.slugField];
            if ((slug === null || slug === undefined) && rules.fallback && locale !== undefined) {
              const fallbackResult = await content.get(t, id, { locale, fallback: true });
              if (isErr(fallbackResult)) return err(transientOnly(fallbackResult.error));
              slug = fallbackResult.value?.[rules.slugField];
            }
            if (typeof slug === "string" && slug !== "") path = publicPath(slug, locale, model.defaultLocale, rules.home, rules.prefixPrimary);
          }
        }
        paths.set(ref, path);
        links[id] = path ? { path, locale: locale ?? "" } : { broken: true };
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(document)) out[k] = k.startsWith("_") || k === "id" ? v : rewrite(v, paths);
      out._links = links;
      return ok(out as ContentDocument);
    },
  };
}
