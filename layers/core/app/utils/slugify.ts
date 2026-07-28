/**
 * Turn arbitrary text (a record title) into a url-safe slug: lowercase, fold diacritics to ASCII
 * (`Über` → `uber`, `Café` → `cafe`) via NFKD + combining-mark removal, then collapse every run of
 * non-`[a-z0-9]` into a single hyphen and trim the ends. Letters with no ASCII fold (ß, CJK, …) act as
 * separators — Kestrel does NO language-specific transliteration, so the result is predictable. Returns
 * `''` for blank / symbol-only input (the caller decides: fall back to the manual slug, or reject). Pure.
 */
export function slugify(input: string): string {
  if (typeof input !== 'string') return ''
  return input
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // strip combining diacritical marks left by NFKD (é → e, ü → u)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
