import type { Content, ContentDocument, ContentError, ContentModel, LocaleOptions } from "@michaelthielemann/kestrel-contracts/content";
import { publishedLocale } from "@michaelthielemann/kestrel-contracts/content-locale";
import { err, isErr, ok, type Result } from "@michaelthielemann/kestrel-contracts/errors";
import type { LinkTarget } from "@michaelthielemann/kestrel-contracts/links";
import { INTERNAL_REF, collectInternalRefs } from "@michaelthielemann/kestrel-contracts/links";
import type { Filter } from "@michaelthielemann/kestrel-contracts/query";
import type { Site, SiteError, SiteRules } from "@michaelthielemann/kestrel-contracts/site";
import { noteRead, unobserved } from "@michaelthielemann/kestrel/reads";

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
}

function isTransient(error: ContentError): error is SiteError {
  return error.code === "TRANSIENT";
}

function transientOnly(error: ContentError): SiteError {
  if (!isTransient(error)) throw new Error(`site/default: unexpected content@1 error ${error.code}: ${error.message}`);
  return error;
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
      const slug = parsed.slug === "" ? rules.home : parsed.slug;
      const lookup = { ...rules.filter, [rules.slugField]: slug };
      const effective = parsed.locale ?? model.defaultLocale;
      const missed: Array<string | undefined> = [];
      const answered = await unobserved(async (): Promise<Result<{ candidate: string | null; doc: ContentDocument | null }, SiteError>> => {
        const page = await content.list(type, lookup, { ...read, limit: 1 });
        if (isErr(page)) return err(transientOnly(page.error));
        let candidate: ContentDocument | undefined = page.value.items[0];
        if (!candidate) missed.push(effective);
        if (!candidate && rules.fallback && read.locale !== undefined && read.locale !== model.defaultLocale) {
          const viaDefaultPage = await content.list(type, lookup, { limit: 1 });
          if (isErr(viaDefaultPage)) return err(transientOnly(viaDefaultPage.error));
          candidate = viaDefaultPage.value.items[0];
          if (!candidate) missed.push(model.defaultLocale);
        }
        if (!candidate) return ok({ candidate: null, doc: null });
        const viewResult = await publishedLocale(content, type, candidate.id, read.locale, rules.filter, { fallback: rules.fallback });
        if (isErr(viewResult)) return err(transientOnly(viewResult.error));
        return ok({ candidate: candidate.id, doc: viewResult.value });
      });
      if (isErr(answered)) return answered;
      for (const locale of missed) noteRead({ kind: "query", type, filter: lookup, ...(locale === undefined ? {} : { locale }) });
      const { candidate, doc } = answered.value;
      if (candidate !== null) noteRead({ kind: "document", type, id: candidate, ...(effective === undefined ? {} : { locale: effective }) });
      if (!doc) return ok(null);
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
        const at = ref.indexOf(":");
        const t = ref.slice(0, at);
        const id = ref.slice(at + 1);
        let path: string | null = null;
        if (model.types[t]) {
          const viewResult = await unobserved(() => publishedLocale(content, t, id, locale, rules.filter, { fallback: rules.fallback, translations: false }));
          if (isErr(viewResult)) return err(transientOnly(viewResult.error));
          const slug = viewResult.value?.[rules.slugField];
          if (typeof slug === "string" && slug !== "") path = publicPath(slug, locale, model.defaultLocale, rules.home, rules.prefixPrimary);
          noteRead({ kind: "path", type: t, id, locale: locale ?? "", rules: { ...rules }, path });
        }
        paths.set(ref, path);
        links[id] = path ? { path, locale: locale ?? "" } : { broken: true };
      }
      const out: ContentDocument = { ...document };
      for (const [k, v] of Object.entries(document)) if (!k.startsWith("_") && k !== "id") out[k] = rewrite(v, paths);
      out._links = links;
      return ok(out);
    },
  };
}
