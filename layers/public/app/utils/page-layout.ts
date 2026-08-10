/** The layout every page falls back to. Nuxt's own name for the unnamed layout, and the one the public
 *  layer ships (`layers/public/app/layouts/default.vue`), so it is always present. */
export const DEFAULT_LAYOUT = 'default'

/**
 * The layout name to render a page in, from its stored `layout` column.
 *
 * Must never return an empty value. The catch-all declares `definePageMeta({ layout: false })` so the page
 * owns its own `<NuxtLayout>`; that makes `route.meta.layout` the literal `false`, and NuxtLayout resolves
 * `unref(props.name) ?? route.meta.layout ?? …` — `??` keeps `false`, which fails its `hasLayout` check and
 * renders the page with NO layout wrapper. The `fallback` prop does not cover this: it only applies to a
 * truthy name absent from the layout map. Coalescing here is what keeps an unset column rendering the
 * normal site frame.
 */
export function resolvePageLayout(stored: string | null | undefined): string {
  const name = typeof stored === 'string' ? stored.trim() : ''
  return name || DEFAULT_LAYOUT
}
