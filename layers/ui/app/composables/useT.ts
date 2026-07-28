import { en } from '../i18n/en'
import { de } from '../i18n/de'

export type Catalog = Record<string, string>

/** Admin-UI languages that ship a catalog. The first is the source + fallback language. */
export const ADMIN_LANGS = ['en', 'de'] as const
export type AdminLang = (typeof ADMIN_LANGS)[number]

const catalogs: Record<string, Catalog> = { en, de }

/** Replace `{name}` placeholders from `params`; an absent param leaves its placeholder untouched. */
export function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m))
}

/** Resolve `key` in the active catalog, then the fallback (en), then the key itself; interpolate. Pure. */
export function translate(catalog: Catalog, fallback: Catalog, key: string, params?: Record<string, unknown>): string {
  return interpolate(catalog[key] ?? fallback[key] ?? key, params)
}

/**
 * Admin-UI translation. `t(key, params?)` reads the active admin language (a cookie-backed preference,
 * separate from the content locale the editor edits) and is reactive — switching the language re-renders.
 * Missing keys fall back to English, then to the key, so a partial `de` catalog degrades gracefully.
 */
export function useT() {
  const lang = useAdminLang()
  const t = (key: string, params?: Record<string, unknown>) => translate(catalogs[lang.value] ?? en, en, key, params)
  return { t, lang }
}
