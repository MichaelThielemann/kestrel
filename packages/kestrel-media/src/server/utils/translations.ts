/** One locale's translatable field values (alt/title/description). */
export type LocaleFields = Record<string, unknown>
/** A media row's `translations` column shape, keyed by locale. */
export type Translations = Record<string, LocaleFields>

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep-merge a partial translations patch into the current map: new locales are added, and within a
 *  locale the patched fields are merged over the existing ones — so patching `en.alt` keeps `en.title`
 *  / `en.description`, and other locales are untouched. Defensive against malformed input: a non-object
 *  current/patch or a non-object per-locale value is ignored rather than persisting garbage. */
export function mergeTranslations(current: Translations | null | undefined, patch: Translations): Translations {
  const out: Translations = isPlainObject(current) ? { ...current } : {}
  if (!isPlainObject(patch)) return out
  for (const [loc, fields] of Object.entries(patch)) {
    if (!isPlainObject(fields)) continue
    out[loc] = { ...(isPlainObject(out[loc]) ? out[loc] : {}), ...fields }
  }
  return out
}
