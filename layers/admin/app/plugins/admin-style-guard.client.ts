import { isProtectedStyle } from '../utils/admin-style-guard'

function isKestrelOwned(node: Element): boolean {
  const el = node as HTMLElement
  const devId = el.dataset?.viteDevId ?? '' // Vite stamps the source path here in dev
  const href = node.getAttribute?.('href') ?? ''
  return isProtectedStyle(devId, href, el.dataset?.kestrel !== undefined)
}

/**
 * Dev-only admin style guard — keeps a consumer's public CSS out of /admin.
 *
 * In `pnpm dev` the whole app (the consumer's public site AND /admin) is ONE Vite SPA sharing one
 * `<head>`. A consumer's public global CSS — typically a reset with bare `html { font-size: … }`, `*`,
 * `#__nuxt > div`, `body` — is injected as a persistent `<style>` the moment a public route renders, and
 * Vite/Nuxt never unload it on client-side navigation. Soft-navigating to /admin therefore leaves that
 * sheet live, and because it is globally-selectored it restyles the admin shell (rescaled rems from a
 * changed root font-size, a collapsed rail, wrong fonts). Layout-chunk code-splitting only governs WHEN a
 * sheet is loaded, never WHICH elements it matches once it is present in a shared document — so it is not
 * isolation. This puts the defense upstream so consumers never have to scope their own styles defensively.
 *
 * While the active route is under /admin, this guard disables every stylesheet that is NOT Kestrel's own
 * by flipping its `media` to `not all` (remembering the previous value so it can be restored exactly on
 * leave — reversible, so returning to a public route never leaves it unstyled), and it watches `<head>` so
 * any sheet injected later (HMR, another layer) is disabled too. On leaving /admin it restores everything.
 *
 * Gated to development: in production the public site ships as a separate static `nuxt generate` build with
 * no /admin routes, and the origin serves /admin as its own document — there is no shared `<head>` to guard.
 * Client-only (the static renderer never runs client plugins). Note: Kestrel's admin also re-asserts the
 * root font-size inline while its layout is mounted (see admin.vue), which defends the rem base even in a
 * single-origin production deployment where this dev guard is inactive.
 */
export default defineNuxtPlugin(() => {
  if (!import.meta.dev) return

  // Foreign sheets we disabled → their previous `media` value (null = attribute was absent).
  const disabled = new Map<Element, string | null>()
  let observer: MutationObserver | undefined

  const disableForeign = () => {
    for (const node of document.querySelectorAll('style, link[rel~="stylesheet"]')) {
      if (isKestrelOwned(node) || disabled.has(node)) continue
      disabled.set(node, node.getAttribute('media'))
      node.setAttribute('media', 'not all')
    }
  }

  const restoreAll = () => {
    for (const [node, media] of disabled) {
      if (media === null) node.removeAttribute('media')
      else node.setAttribute('media', media)
    }
    disabled.clear()
  }

  // Runs on the initial client navigation and every subsequent one. A named global middleware — the
  // anonymous form cannot take `{ global: true }`.
  addRouteMiddleware(
    'kestrel-admin-style-guard',
    (to) => {
      const onAdmin = to.path === '/admin' || to.path.startsWith('/admin/')
      if (!onAdmin) {
        observer?.disconnect()
        observer = undefined
        restoreAll()
        return
      }
      disableForeign()
      if (!observer) {
        observer = new MutationObserver(disableForeign)
        observer.observe(document.head, { childList: true, subtree: true })
      }
    },
    { global: true },
  )
})
