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

/** The discovered names as a module body, so the admin bundle can import a build-time constant. */
export function renderLayoutRegistry(names: string[]): string {
  return `export const kestrelLayouts = ${JSON.stringify(names)}\n`
}

/**
 * Options for the page-layout select. The fallback is one entry with an EMPTY value — an unset column
 * already renders `default`, so offering `default` as its own value would give the editor two controls for
 * one outcome and pin the row to a name the consumer may later rename.
 */
export function layoutSelectOptions(names: string[], fallbackLabel: string): { label: string, value: string }[] {
  return [
    { label: fallbackLabel, value: '' },
    ...names.filter((n) => n !== DEFAULT_LAYOUT_NAME).map((n) => ({ label: n, value: n })),
  ]
}

/** Mirrors `DEFAULT_LAYOUT` in the public layer; kept local so this util stays dependency-free. */
const DEFAULT_LAYOUT_NAME = 'default'
