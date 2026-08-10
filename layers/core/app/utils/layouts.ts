/** The admin shell. Never offerable for a public record — a page rendered inside it would carry the
 *  admin chrome and its own `useHead`. */
export const ADMIN_LAYOUT = 'admin'

/** Nuxt's resolved `app.layouts` entry (`nuxt.options.app.layouts`, filled before the `app:resolve` hook). */
export interface ResolvedLayout { name: string, file: string }

/**
 * The layout names a page may be assigned, from Nuxt's own resolved layout map. Nuxt has already done the
 * layer-ordered, name-first dedup (a consumer's `default.vue` shadows the engine's), so this only filters
 * and sorts — no directory scan of our own.
 */
export function offerableLayouts(layouts: Record<string, ResolvedLayout | undefined>): string[] {
  return Object.values(layouts)
    .filter((l): l is ResolvedLayout => !!l && typeof l.file === 'string' && l.file.endsWith('.vue'))
    .map((l) => l.name)
    .filter((name) => name !== ADMIN_LAYOUT)
    .sort()
}
