import type { Content, ContentDocument, ContentError, ContentModel } from "./content.ts";
import { isErr, ok, type Result } from "./errors.ts";
import type { Filter } from "./query.ts";

function isLocalizedField(model: ContentModel, type: string, field: string): boolean {
  const raw = model.types[type]?.fields[field];
  return raw !== undefined && typeof raw !== "string" && raw.localized === true;
}

/** The entries of `filter` that are shared across every locale of a document (not declared `localized`). */
export function nonLocalizedFilter(model: ContentModel, type: string, filter: Filter): Filter {
  return Object.fromEntries(Object.entries(filter).filter(([f]) => !isLocalizedField(model, type, f)));
}

/** Whether a document's own field values (one locale, fetched strictly) satisfy every entry of `filter`. */
export function satisfiesFilter(filter: Filter, values: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(filter).every(([f, v]) => values?.[f] === v);
}

/**
 * `id`'s field values at `locale`, restricted to what `filter` allows to be served there: `null`
 * when `locale` itself does not satisfy `filter` (a locale that fails the filter is never replaced
 * by another one). With `fallback`, an empty localized field is filled from the default locale, but
 * only when the default locale's own values satisfy `filter` too — a locale that fails the filter is
 * never a fallback source, so the field stays empty instead. `_translations`, when present, is
 * narrowed the same way: a locale counts only once its own values also satisfy `filter`.
 */
export async function publishedLocale(
  content: Content,
  model: ContentModel,
  type: string,
  id: string,
  locale: string | undefined,
  filter: Filter,
  fallback: boolean,
): Promise<Result<ContentDocument | null, ContentError>> {
  const cache = new Map<string | undefined, ContentDocument | null>();
  const strictOf = async (l: string | undefined): Promise<Result<ContentDocument | null, ContentError>> => {
    if (cache.has(l)) return ok(cache.get(l) ?? null);
    const fetched = await content.get(type, id, l === undefined ? {} : { locale: l });
    if (isErr(fetched)) return fetched;
    cache.set(l, fetched.value);
    return fetched;
  };

  const strictResult = await strictOf(locale);
  if (isErr(strictResult)) return strictResult;
  if (!satisfiesFilter(filter, strictResult.value)) return ok(null);

  let doc = strictResult.value;
  if (doc && fallback && locale !== undefined && model.defaultLocale !== undefined && locale !== model.defaultLocale) {
    const defaultResult = await strictOf(model.defaultLocale);
    if (isErr(defaultResult)) return defaultResult;
    if (satisfiesFilter(filter, defaultResult.value)) {
      const merged = await content.get(type, id, { locale, fallback: true });
      if (isErr(merged)) return merged;
      if (merged.value) doc = merged.value;
    }
  }

  if (doc?._translations) {
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
