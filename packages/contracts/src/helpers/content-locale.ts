import type { Content, ContentDocument, ContentError } from "../content.ts";
import { isErr, ok, type Result } from "../errors.ts";
import type { Filter } from "../query.ts";

const RESERVED_FIELDS = new Set(["id", "createdAt", "updatedAt"]);

/**
 * Whether `id`'s row at `locale` satisfies `filter`, decided by `content.list` itself: a
 * `Condition` entry (`{ in: [...] }`, `{ ne: ... }`, …) is evaluated with the store's own
 * semantics, never reimplemented here, so it can never turn into a false negative or a thrown
 * error at request time. `id` is ignored for a single type, which `content@1` itself never keys by
 * id either; for a multi type, a missing `id` is `false` — never "does any document pass", the
 * question a filter with no `id` would otherwise answer. `false` without a read when `filter` names
 * a field `type` does not declare (a link to another type that happens not to carry the filter's
 * fields is simply unserved, not an error) or when `filter` has no entries to fail — an empty
 * filter is always satisfied.
 */
export async function satisfiesFilter(content: Content, type: string, id: string | undefined, locale: string | undefined, filter: Filter): Promise<Result<boolean, ContentError>> {
  if (Object.keys(filter).length === 0) return ok(true);
  const definition = content.model().types[type];
  const single = definition?.kind === "single";
  if (!single && id === undefined) return ok(false);
  const fields = definition?.fields ?? {};
  if (!Object.keys(filter).every((f) => RESERVED_FIELDS.has(f) || f in fields)) return ok(false);
  const page = await content.list(type, { ...filter, ...(single ? {} : { id }) }, { ...(locale === undefined ? {} : { locale }), limit: 1 });
  if (isErr(page)) return page;
  return ok(page.value.total > 0);
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
 * narrowed the same way: a locale counts only once its own values also satisfy `filter`. At the
 * default locale itself, `fallback` still reads with `content@1`'s own `fallback: true` once more
 * (there is no other locale to inherit a field from, but `content@1` still names each field's own
 * locale in `_locales`, and a caller asking for `fallback: true` gets that back either way).
 */
export async function publishedLocale(content: Content, type: string, id: string | undefined, locale: string | undefined, filter: Filter, options: PublishedLocaleOptions): Promise<Result<ContentDocument | null, ContentError>> {
  const model = content.model();
  const effective = locale ?? model.defaultLocale;

  const strictResult = await content.get(type, id, locale === undefined ? {} : { locale });
  if (isErr(strictResult)) return strictResult;
  const holds = await satisfiesFilter(content, type, id, locale, filter);
  if (isErr(holds)) return holds;
  if (!holds.value) return ok(null);

  let doc = strictResult.value;
  if (doc && options.fallback) {
    if (locale !== undefined && model.defaultLocale !== undefined && locale !== model.defaultLocale) {
      const defaultHolds = await satisfiesFilter(content, type, id, model.defaultLocale, filter);
      if (isErr(defaultHolds)) return defaultHolds;
      if (defaultHolds.value) {
        const merged = await content.get(type, id, { locale, fallback: true });
        if (isErr(merged)) return merged;
        if (merged.value) doc = merged.value;
      }
    } else {
      const merged = await content.get(type, id, { ...(locale === undefined ? {} : { locale }), fallback: true });
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
      if (l === effective) {
        translations[l] = true;
        continue;
      }
      const lHolds = await satisfiesFilter(content, type, id, l, filter);
      if (isErr(lHolds)) return lHolds;
      translations[l] = lHolds.value;
    }
    doc = { ...doc, _translations: translations };
  }

  return ok(doc);
}

const ID_CHUNK_SIZE = 500;

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/**
 * `items` (a `content.list` page) with `_translations` narrowed to the locales that satisfy
 * `filter` themselves, batched across the whole page: one `content.list` call per locale other
 * than `requestedLocale` (already known from `items` matching `filter` there) per chunk of at most
 * `ID_CHUNK_SIZE` ids, not one call per item and never one unbounded `in` list — the store decides
 * each locale's membership the same way `satisfiesFilter` does, `Condition` entries included. A
 * no-op when `filter` is empty, the model has no other locale, or no item carries `_translations`.
 */
export async function narrowListTranslations(content: Content, type: string, items: ContentDocument[], filter: Filter, requestedLocale: string | undefined): Promise<Result<ContentDocument[], ContentError>> {
  if (Object.keys(filter).length === 0 || items.length === 0 || !items.some((d) => d._translations)) return ok(items);
  const model = content.model();
  const effective = requestedLocale ?? model.defaultLocale;
  const otherLocales = (model.locales ?? []).filter((l) => l !== effective);
  if (otherLocales.length === 0) return ok(items);

  const idChunks = chunk(
    items.map((d) => d.id),
    ID_CHUNK_SIZE,
  );
  const passing = new Map<string, Set<string>>();
  for (const l of otherLocales) {
    const matched = new Set<string>();
    for (const ids of idChunks) {
      const page = await content.list(type, { ...filter, id: { in: ids } }, { locale: l, limit: ids.length });
      if (isErr(page)) return page;
      for (const d of page.value.items) matched.add(d.id);
    }
    passing.set(l, matched);
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
