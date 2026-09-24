import type { Content, ContentDocument, ContentError } from "./content.ts";
import { isErr, ok, type Result } from "./errors.ts";
import type { Filter } from "./query.ts";

const CONDITION_OPERATORS = new Set(["eq", "ne", "gt", "gte", "lt", "lte", "in", "like"]);

function isCondition(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 1 && Object.keys(value).every((k) => CONDITION_OPERATORS.has(k));
}

/**
 * Whether a document's own field values (one locale, fetched strictly) satisfy every entry of
 * `filter`. Only scalar equality is evaluated; a `Condition` (`{ in: [...] }`, `{ ne: ... }`, …)
 * throws instead of silently failing every document it is compared against.
 */
export function satisfiesFilter(filter: Filter, values: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(filter).every(([f, v]) => {
    if (isCondition(v)) throw new Error(`content-locale: satisfiesFilter needs scalar equality, got a Condition for "${f}"`);
    return values?.[f] === v;
  });
}

export interface PublishedLocaleOptions {
  /** Fill an empty localized field from the default locale, but only once the default locale's own values satisfy `filter` too. */
  fallback: boolean;
  /** Narrow `_translations` to the locales that satisfy `filter` themselves. Default `true`; a caller that only reads one field can pass `false` to skip the extra per-locale reads. */
  translations?: boolean;
}

/**
 * `id`'s field values at `locale`, restricted to what `filter` allows to be served there: `null`
 * when `locale` itself does not satisfy `filter` (a locale that fails the filter is never replaced
 * by another one). With `fallback`, an empty localized field is filled from the default locale, but
 * only when the default locale's own values satisfy `filter` too — a locale that fails the filter is
 * never a fallback source, so the field stays empty instead. `_translations`, when present, is
 * narrowed the same way: a locale counts only once its own values also satisfy `filter`.
 */
export async function publishedLocale(content: Content, type: string, id: string | undefined, locale: string | undefined, filter: Filter, options: PublishedLocaleOptions): Promise<Result<ContentDocument | null, ContentError>> {
  const model = content.model();
  const keyOf = (l: string | undefined): string | undefined => l ?? model.defaultLocale;
  const cache = new Map<string | undefined, ContentDocument | null>();
  const strictOf = async (l: string | undefined): Promise<Result<ContentDocument | null, ContentError>> => {
    const key = keyOf(l);
    if (cache.has(key)) return ok(cache.get(key) ?? null);
    const fetched = await content.get(type, id, l === undefined ? {} : { locale: l });
    if (isErr(fetched)) return fetched;
    cache.set(key, fetched.value);
    return fetched;
  };

  const strictResult = await strictOf(locale);
  if (isErr(strictResult)) return strictResult;
  if (!satisfiesFilter(filter, strictResult.value)) return ok(null);

  let doc = strictResult.value;
  if (doc && options.fallback && locale !== undefined && model.defaultLocale !== undefined && locale !== model.defaultLocale) {
    const defaultResult = await strictOf(model.defaultLocale);
    if (isErr(defaultResult)) return defaultResult;
    if (satisfiesFilter(filter, defaultResult.value)) {
      const merged = await content.get(type, id, { locale, fallback: true });
      if (isErr(merged)) return merged;
      if (merged.value) doc = merged.value;
    }
  }

  if (doc?._translations && options.translations !== false && Object.keys(filter).length > 0) {
    const translations: Record<string, boolean> = {};
    for (const [l, complete] of Object.entries(doc._translations)) {
      if (!complete) {
        translations[l] = false;
        continue;
      }
      const localeResult = await strictOf(l);
      if (isErr(localeResult)) return localeResult;
      translations[l] = satisfiesFilter(filter, localeResult.value);
    }
    doc = { ...doc, _translations: translations };
  }

  return ok(doc);
}

/**
 * `items` (a `content.list` page) with `_translations` narrowed to the locales that satisfy
 * `filter` themselves, batched across the whole page: one `content.list` call per locale other
 * than `requestedLocale` (already known from `items` matching `filter` there), not one per item.
 * A no-op when `filter` is empty, the model has no other locale, or no item carries `_translations`.
 */
export async function narrowListTranslations(content: Content, type: string, items: ContentDocument[], filter: Filter, requestedLocale: string | undefined): Promise<Result<ContentDocument[], ContentError>> {
  if (Object.keys(filter).length === 0 || items.length === 0 || !items.some((d) => d._translations)) return ok(items);
  const model = content.model();
  const effective = requestedLocale ?? model.defaultLocale;
  const otherLocales = (model.locales ?? []).filter((l) => l !== effective);
  if (otherLocales.length === 0) return ok(items);

  const ids = items.map((d) => d.id);
  const passing = new Map<string, Set<string>>();
  for (const l of otherLocales) {
    const page = await content.list(type, { ...filter, id: { in: ids } }, { locale: l, limit: ids.length });
    if (isErr(page)) return page;
    passing.set(l, new Set(page.value.items.map((d) => d.id)));
  }

  return ok(
    items.map((doc) => {
      if (!doc._translations) return doc;
      const translations: Record<string, boolean> = {};
      for (const [l, complete] of Object.entries(doc._translations)) translations[l] = l === effective ? complete : complete && (passing.get(l)?.has(doc.id) ?? false);
      return { ...doc, _translations: translations };
    }),
  );
}
