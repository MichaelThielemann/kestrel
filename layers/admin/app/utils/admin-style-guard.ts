// Kestrel's own stylesheets live under `…/kestrel/layers/…`; its extensions ship as `kestrel-*` packages
// (or a monorepo `extensions/` dir → still resolved through a `kestrel-*` name). A Vue `<style scoped>`
// block is component-scoped (its rules carry a `data-v-<hash>` attribute), so it can NEVER be the global
// public CSS this guard targets — keep it wherever it comes from, which is what extension AND consumer
// admin widgets (custom field types, registered editor bodies) rely on.
const KESTREL_OWNED = /[/\\]kestrel[/\\]layers[/\\]/
const KESTREL_EXTENSION = /[/\\]kestrel-[^/\\]+[/\\]/
const SCOPED = /[?&]scoped[=&]/

/**
 * Whether a stylesheet must be PROTECTED from the dev admin style-guard (i.e. NOT disabled on /admin). True
 * for Kestrel core/extension sheets, any component-scoped Vue style, or a node explicitly tagged
 * `data-kestrel`. Only genuinely foreign global CSS (a consumer's unscoped public reset) falls through to
 * false and gets disabled. Pure → unit-tested without a DOM.
 */
export function isProtectedStyle(devId: string, href: string, hasDataKestrel: boolean): boolean {
  if (hasDataKestrel) return true
  if (SCOPED.test(devId)) return true
  return KESTREL_OWNED.test(devId) || KESTREL_OWNED.test(href) || KESTREL_EXTENSION.test(devId) || KESTREL_EXTENSION.test(href)
}
